#![cfg(target_os = "macos")]
//! The e2e checks of the LaTeX source's own lint (`editor_panel/index_lint.rs`
//! feeding `lattice_editor::latex::lint`), on a scratch `lint.tex` in the
//! fixture: an unknown `\ref` is underlined while the fixture's own label is
//! not, a native pointer resting on it opens the lint card, an `\input` the
//! project does not have offers Create file, one written in another letter
//! case offers Fix case, and an environment left open is an error. Fix case
//! respells the path in the buffer and Create file makes the file and opens
//! it, after which neither finding is reported again. The scratch files go
//! after.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity, point, px};
use lattice_editor::latex::{
    diagnostics::Severity,
    lint::{Lint, LintAction, marks::LAYER},
};
use serde_json::json;

use super::Steps;
use crate::{editor_panel::EditorPanel, scenario::Run};

const SCRATCH: &str = "lint.tex";
const MISSING: &str = "chapters/lint-missing.tex";
const TEXT: &str = "\\begin{itemize}\n\
\\item See \\ref{sec:nowhere} and \\ref{sec:method}.\n\
\\end{itemize}\n\
\\input{chapters/lint-missing}\n\
\\input{Chapters/intro}\n\
\\begin{figure}\n";

fn lints(cx: &mut AsyncApp, panel: &Entity<EditorPanel>) -> Vec<Lint> {
    cx.update(|cx| {
        panel
            .read(cx)
            .index_lint()
            .map(|lint| lint.read(cx).marks().read(cx).shown(cx))
            .unwrap_or_default()
    })
}

/// Run the `index`th finding's action, as its card's button does.
fn run_action(cx: &mut AsyncApp, panel: &Entity<EditorPanel>, index: usize) {
    cx.update(|cx| {
        let marks = panel
            .read(cx)
            .index_lint()
            .map(|lint| lint.read(cx).marks().clone());
        if let Some(marks) = marks {
            marks.update(cx, |marks, cx| marks.run_action(index, cx));
        }
    });
}

fn names(lints: &[Lint], needle: &str) -> bool {
    lints.iter().any(|lint| lint.message.contains(needle))
}

impl Run {
    pub(super) async fn index_lint(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let scratch = root.join(SCRATCH);
        std::fs::write(&scratch, TEXT)?;
        let panel = self.open(cx, &scratch, Some(1))?;
        let wait_panel = panel.clone();
        self.wait_for(cx, Duration::from_secs(10), move |_, cx| {
            let lint = wait_panel
                .read(cx)
                .index_lint()
                .map(|lint| lint.read(cx).marks().read(cx).shown(cx));
            lint.is_some_and(|lints| names(&lints, "sec:nowhere"))
        })
        .await;
        let found = lints(cx, &panel);
        let summary: Vec<_> = found
            .iter()
            .map(|lint| json!({ "message": lint.message, "action": format!("{:?}", lint.action) }))
            .collect();
        let lattice = cx.update(|cx| panel.read(cx).lattice_editor().clone());
        let marked = cx.update(|cx| lattice.read(cx).mark_ranges(LAYER, cx));
        let at = TEXT.find("sec:nowhere").context("the unknown label")?;
        steps.check(
            "the source's lint underlines an unknown \\ref's label but not one the project defines, as the Tauri app's index lint does",
            names(&found, "“sec:nowhere”")
                && !names(&found, "sec:method")
                && marked.iter().any(|range| range.contains(&at)),
            json!({ "lints": summary, "marked": format!("{marked:?}") }),
        );
        let create = found.iter().find_map(|lint| match &lint.action {
            Some(LintAction::CreateFile(path)) => Some(path.clone()),
            _ => None,
        });
        let fix = found.iter().position(|lint| {
            matches!(&lint.action, Some(LintAction::FixCase { insert, .. }) if insert == "chapters/intro")
        });
        let unclosed = found
            .iter()
            .any(|lint| lint.severity == Severity::Error && lint.message.contains("figure"));
        steps.check(
            "a missing \\input offers Create file, one written in another case offers Fix case, and an environment left open is an error",
            create.as_deref() == Some(MISSING) && fix.is_some() && unclosed,
            json!({ "create": create, "fix": fix, "unclosed": unclosed, "lints": summary }),
        );

        // A native pointer resting on the unknown label opens the lint card.
        let (_, rect) = self
            .text_point(cx, &panel, &lattice, "sec:nowhere", 2)
            .await?;
        self.hover_at(cx, point(rect.left() + px(2.), rect.center().y))
            .await?;
        let card = self.wait_for_card(cx, &lattice, "lint").await;
        self.adapter_shot(cx, "index-lint-card").await;
        steps.check(
            "a native pointer resting on a lint underline opens the lint card over it",
            card.as_ref()
                .is_some_and(|(range, bounds)| range.contains(&at) && bounds.is_some()),
            json!({ "card": card.map(|(range, _)| format!("{range:?}")) }),
        );
        self.hover_at(cx, point(px(4.), px(4.))).await?;

        // Fix case: the path respelled, and the finding gone after the run.
        if let Some(fix) = fix {
            run_action(cx, &panel, fix);
        }
        let wait_panel = panel.clone();
        let fixed = self
            .wait_for(cx, Duration::from_secs(5), move |_, cx| {
                let text = wait_panel.read(cx).text_and_caret(cx).0;
                let lints = wait_panel
                    .read(cx)
                    .index_lint()
                    .map(|lint| lint.read(cx).marks().read(cx).shown(cx))
                    .unwrap_or_default();
                text.contains("\\input{chapters/intro}") && !names(&lints, "differs in case")
            })
            .await;
        steps.check(
            "Fix case respells the \\input's path in the file's case, and the lint stops reporting it",
            fixed,
            json!({ "text": self.editor_text(cx, &panel) }),
        );

        // Create file: the file made and opened, the finding gone.
        let missing = root.join(MISSING);
        let create_at = found
            .iter()
            .position(|lint| matches!(lint.action, Some(LintAction::CreateFile(_))));
        if let Some(index) = create_at {
            run_action(cx, &panel, index);
        }
        let shell = self.shell.clone();
        let opened = self
            .wait_for(cx, Duration::from_secs(5), move |_, cx| {
                shell
                    .read(cx)
                    .active_editor()
                    .is_some_and(|editor| editor.read(cx).relative() == MISSING)
            })
            .await;
        let wait_panel = panel.clone();
        let gone = self
            .wait_for(cx, Duration::from_secs(5), move |_, cx| {
                let lints = wait_panel
                    .read(cx)
                    .index_lint()
                    .map(|lint| lint.read(cx).marks().read(cx).shown(cx))
                    .unwrap_or_default();
                !names(&lints, "lint-missing")
            })
            .await;
        steps.check(
            "Create file makes the missing \\input's file and opens it, and the lint stops reporting it",
            missing.is_file() && opened && gone,
            json!({ "exists": missing.is_file(), "opened": opened, "gone": gone }),
        );

        let created = cx.update(|cx| self.shell.read(cx).active_editor());
        if let Some(created) =
            created.filter(|editor| cx.update(|cx| editor.read(cx).relative() == MISSING))
        {
            self.close_panel(cx, &created).await?;
        }
        // The fix left the scratch file unsaved; it goes either way.
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
        std::fs::remove_file(&missing).ok();
        Ok(())
    }
}

/// This file's registration as the e2e module `index_lint` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 116,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/index_lint.rs",
        "gpui/crates/lattice-editor/src/latex/lint",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.index_lint(cx, steps, &fixture.root)),
};
