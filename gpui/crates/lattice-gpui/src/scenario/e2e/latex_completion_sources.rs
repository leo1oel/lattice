#![cfg(target_os = "macos")]
//! The e2e checks of the completion sources that read the project's files
//! (`lattice_editor::latex::project_completions`) and TexLab
//! (`latex::texlab_completions`), typed with native keys in a scratch
//! `completion.tex`: `\input{chap` lists the chapter's `.tex` file and Enter
//! writes it, `\includegraphics{` lists a figure under the `\graphicspath`
//! root another file sets, by its path relative to that root, a command the
//! open file defines with `\newcommand` is listed for its first letters, as
//! is one another file defines, `\cmpd{` lists another file's chemnum key
//! and a drawing's mark, which picked there is written as `\rcmpd{…}`, and,
//! with TexLab installed, TexLab's items
//! join the menu (the `\input`'s folder entry, which Lattice's own sources
//! never list). The scratch files go after.

use std::{path::Path, time::Duration};

use anyhow::Result;
use editor::SelectionEffects;
use gpui::{AsyncApp, Entity};
use lattice_editor::TexlabService;
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

const SCRATCH: &str = "completion.tex";
const MACROS: &str = "completion-macros.tex";
const FIGURE: &str = "completion-figures/plot.png";
/// An editable figure's entry file, which names a drawing's mark.
const ROUTE: &str = "completion-figures/route.tex";
const TEXT: &str = "\\newcommand{\\Rset}{\\mathbb{R}}\n\n";

impl Run {
    pub(super) async fn latex_completion_sources(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let scratch = root.join(SCRATCH);
        let macros = root.join(MACROS);
        let figure = root.join(FIGURE);
        std::fs::create_dir_all(figure.parent().expect("the figure has a folder"))?;
        std::fs::write(&figure, b"")?;
        std::fs::write(
            &macros,
            "\\graphicspath{{completion-figures/}}\n\\newcommand{\\cZq}{\\mathcal{Z}}\n\
             See \\cmpd{ketone}.\n\\begin{scheme}\\input{completion-figures/route}\\caption{Route}\\end{scheme}\n",
        )?;
        std::fs::write(
            root.join(ROUTE),
            "% editable-figure source: route.cdxml\n\\rcmpd{alcohol.a.num}\n",
        )?;
        std::fs::write(&scratch, TEXT)?;
        // The project's tree takes the new files in before the editor reads it.
        let shell = self.shell.clone();
        self.wait_for(cx, Duration::from_secs(10), move |_, cx| {
            shell.read(cx).project().is_some_and(|project| {
                let files = project.read(cx).files();
                let mut paths = Vec::new();
                crate::editor_panel::definition::project_paths(files, &mut paths);
                [FIGURE, MACROS, ROUTE]
                    .iter()
                    .all(|wanted| paths.iter().any(|path| path == wanted))
            })
        })
        .await;
        let panel = self.open(cx, &scratch, Some(3))?;
        self.pause(cx, Duration::from_millis(600)).await;

        // With TexLab installed, read the menu once TexLab's answer has joined
        // it: the first ask may wait for TexLab to start (1.5 s) behind a
        // diagnostics sync holding its pool (up to 1.2 s), and then for the
        // ask itself (up to 1.2 s), well past the pause `typed_menu` takes.
        let texlab = TexlabService::available().then_some("chapters");
        let input_menu = self
            .typed_menu_until(cx, &panel, "\\input{chap", texlab)
            .await?;
        self.completion_shot(cx, "completion-input").await;
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let text = self.editor_text(cx, &panel);
        steps.check(
            "typing in an \\input's braces lists the project's .tex files; Enter writes the path",
            input_menu.iter().any(|label| label == "chapters/intro.tex")
                && text.contains("\\input{chapters/intro.tex}"),
            json!({ "menu": input_menu, "text": text }),
        );

        self.end_line(cx, &panel)?;
        let menu = self
            .typed_menu(cx, &panel, "\n\\includegraphics{plo")
            .await?;
        self.completion_shot(cx, "completion-includegraphics").await;
        self.press(cx, '\u{1b}', false).await?;
        steps.check(
            "an \\includegraphics lists a figure by its path and by its path under the \\graphicspath root another file sets",
            menu.iter().any(|label| label == FIGURE) && menu.iter().any(|label| label == "plot.png"),
            json!({ "menu": menu }),
        );

        self.end_line(cx, &panel)?;
        let own = self.typed_menu(cx, &panel, "\n\\Rs").await?;
        self.press(cx, '\u{1b}', false).await?;
        self.end_line(cx, &panel)?;
        let other = self.typed_menu(cx, &panel, " \\cZ").await?;
        self.press(cx, '\u{1b}', false).await?;
        steps.check(
            "after a \\, the commands the open file and another file define with \\newcommand are listed",
            own.first().map(String::as_str) == Some("\\Rset")
                && other.iter().any(|label| label == "\\cZq"),
            json!({ "own": own, "other": other }),
        );

        // Lattice's own sources list files; a folder in the menu is TexLab's.
        // chemnum: another file's key in \cmpd{, and a drawing's mark picked
        // there turns the command into \rcmpd{.
        self.end_line(cx, &panel)?;
        let keys = self.typed_menu(cx, &panel, " \\cmpd{k").await?;
        self.press(cx, '\u{1b}', false).await?;
        self.end_line(cx, &panel)?;
        let marks = self.typed_menu(cx, &panel, " \\cmpd{alcohol.a").await?;
        self.press(cx, '\n', false).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let text = self.editor_text(cx, &panel);
        steps.check(
            "in \\cmpd{ the project's compound keys are listed, and a drawing's mark picked there is written as \\rcmpd{…}",
            keys.first().map(String::as_str) == Some("ketone")
                && marks.first().map(String::as_str) == Some("alcohol.a.num")
                && text.contains("\\rcmpd{alcohol.a.num}")
                && !text.contains("\\cmpd{alcohol"),
            json!({
                "keys": keys,
                "marks": marks,
                "line": text.lines().last(),
                "facts": cx.update(|cx| panel.read(cx).index_lint().map(|lint| {
                    let facts = lint.read(cx).facts().borrow();
                    json!({
                        "paths": facts.paths.len(),
                        "keys": facts.compounds.keys,
                        "places": facts.compounds.place_lines,
                    })
                })),
            }),
        );

        if TexlabService::available() {
            steps.check(
                "with TexLab installed, its completions join the menu: an \\input's lists TexLab's folder entry beside Lattice's files",
                input_menu.iter().any(|label| label == "chapters"),
                json!({ "menu": input_menu }),
            );
        } else {
            steps.check(
                "TexLab's completions join the menu (skipped: texlab is not installed)",
                true,
                json!({ "skipped": true }),
            );
        }

        // Put the buffer back so closing asks nothing, then clear up.
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    let len = panel.text_and_caret(cx).0.len();
                    panel.replace_range(0, len, TEXT, 0, window, cx)
                })
            }
        })?;
        self.close_panel(cx, &panel).await?;
        std::fs::remove_file(&scratch).ok();
        std::fs::remove_file(&macros).ok();
        std::fs::remove_dir_all(root.join("completion-figures")).ok();
        Ok(())
    }

    /// With `LATTICE_E2E_SHOTS` set, the window with its open menu, as
    /// `name.png` in that folder, for a reviewer to look at.
    async fn completion_shot(&self, cx: &mut AsyncApp, name: &str) {
        let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") else {
            return;
        };
        let path = Path::new(&dir).join(format!("{name}.png"));
        if let Err(error) = self.capture(cx, &path.to_string_lossy()).await {
            log::warn!("no shot {name}: {error:#}");
        }
    }

    /// The caret to the end of the buffer.
    fn end_line(&self, cx: &mut AsyncApp, panel: &Entity<EditorPanel>) -> Result<()> {
        let editor = cx.update(|cx| panel.read(cx).editor().clone());
        let end = self.editor_text(cx, panel).len();
        self.with_window(cx, move |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.change_selections(SelectionEffects::default(), window, cx, |selections| {
                    selections.select_ranges([
                        editor::MultiBufferOffset(end)..editor::MultiBufferOffset(end)
                    ])
                });
            })
        })
    }

    /// Type `text` with native keys and read the menu that opens.
    async fn typed_menu(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        text: &str,
    ) -> Result<Vec<String>> {
        self.typed_menu_until(cx, panel, text, None).await
    }

    /// [`Self::typed_menu`], reading the menu once it offers `label` (an item
    /// a later-answering source adds), or after a bound if it never does.
    async fn typed_menu_until(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        text: &str,
        label: Option<&'static str>,
    ) -> Result<Vec<String>> {
        self.type_text(cx, text).await?;
        let editor = cx.update(|cx| panel.read(cx).editor().clone());
        let wait_editor = editor.clone();
        self.wait_for(cx, Duration::from_secs(4), move |_, cx| {
            wait_editor.read(cx).has_visible_completions_menu()
        })
        .await;
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        match label {
            Some(label) => {
                let wait_lattice = lattice.clone();
                self.wait_for(cx, Duration::from_secs(5), move |_, cx| {
                    wait_lattice
                        .read(cx)
                        .offered_completions()
                        .iter()
                        .any(|offered| offered.as_ref() == label)
                })
                .await;
            }
            // TexLab's answer joins the menu a little after it opens.
            None => self.pause(cx, Duration::from_millis(400)).await,
        }
        Ok(cx.update(|cx| {
            if !editor.read(cx).has_visible_completions_menu() {
                return Vec::new();
            }
            lattice
                .read(cx)
                .offered_completions()
                .into_iter()
                .map(|label| label.to_string())
                .collect()
        }))
    }
}

/// This file's registration as the e2e module `latex_completion_sources`
/// (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 117,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-editor/src/latex/project_completions.rs",
        "gpui/crates/lattice-editor/src/latex/texlab_completions.rs",
        "gpui/crates/lattice-editor/src/latex/compound_completion.rs",
        "gpui/crates/lattice-editor/src/latex/compound_places.rs",
        "gpui/crates/lattice-editor/src/completion.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.latex_completion_sources(cx, steps, &fixture.root)),
};
