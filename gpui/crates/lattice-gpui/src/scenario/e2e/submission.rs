//! The e2e checks of getting the manuscript ready to send
//! (`crate::submission`): a TODO marker typed into a chapter listed by the
//! TODOs panel, opened from the palette into the documents' panel, its row
//! opening the chapter; a label's references found and the label renamed
//! through the rename dialog, every `\ref` following it; and the arXiv
//! export sheet checking the built paper and writing its ZIP.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::{
    scenario::Run,
    shell::Shell,
    submission::{arxiv::CheckState, references::SymbolKind, todos::TodosEvent},
};

impl Run {
    pub(super) async fn submission_tools(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        self.todos_panel(cx, steps, root).await?;
        self.symbol_references(cx, steps, root).await?;
        self.arxiv_export(cx, steps, root).await?;
        self.switch_drops_submission_tools(cx, steps, root).await
    }

    /// A second window shows the project with a label's references listed
    /// and the arXiv export sheet open; opening another project in it drops
    /// both, so neither acts on the project shown next (its Open, Rename,
    /// Build first and Export would resolve against that project).
    async fn switch_drops_submission_tools(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let (window, shell) = cx.update(|cx| Shell::open_window(Some(root.to_path_buf()), cx))?;
        let second = self.for_window(shell, window);
        second.root(cx).await?;
        second.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.show_references(SymbolKind::Label, "sec:method".into(), window, cx)
            })
        })?;
        let listed = second
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).references.bar.is_some()
            })
            .await;
        second.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_arxiv_export(window, cx))
        })?;
        let sheet = cx.update(|cx| second.shell.read(cx).sheets.arxiv.is_some());

        let other =
            std::env::temp_dir().join(format!("lattice-gpui-tools-switch-{}", std::process::id()));
        std::fs::create_dir_all(&other)?;
        std::fs::write(other.join("main.tex"), "\\documentclass{article}\n")?;
        // The project's root is the folder's canonical path (/private/var
        // for /var on macOS).
        let other_root = other.canonicalize()?;
        second.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_project(other.clone(), window, cx)
            })
        })?;
        let switched = second
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).root(cx).as_deref() == Some(other_root.as_path())
            })
            .await;
        let (bar_after, sheet_after) = cx.update(|cx| {
            let shell = second.shell.read(cx);
            (shell.references.bar.is_some(), shell.sheets.arxiv.is_some())
        });
        steps.check(
            "opening another project drops the references bar and the arXiv export sheet",
            listed && sheet && switched && !bar_after && !sheet_after,
            json!({
                "before": { "bar": listed, "sheet": sheet },
                "switched": switched,
                "after": { "bar": bar_after, "sheet": sheet_after },
            }),
        );
        window
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        std::fs::remove_dir_all(&other).ok();
        Ok(())
    }

    async fn todos_panel(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter).context("chapters/intro.tex")?;
        std::fs::write(
            &chapter,
            format!("{original}\n% TODO tighten the opening\n"),
        )?;
        cx.update(|cx| crate::status_counters::refresh(root.to_path_buf(), cx));
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_todos(window, cx))
        })?;
        let todos = cx.update(|cx| self.shell.read(cx).todos.clone());
        let listed = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                todos
                    .read(cx)
                    .hits(cx)
                    .iter()
                    .any(|hit| hit.path == "chapters/intro.tex" && hit.preview.contains("tighten"))
            })
            .await;
        let (on_screen, beside_documents, hits) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let panel = shell.panel_holding("todos", cx);
            (
                shell.view_on_screen("todos", cx),
                panel.is_some() && panel == shell.document_panel_of_layout(cx),
                todos.read(cx).hits(cx).len(),
            )
        });
        steps.check(
            "the TODOs panel opens in the documents' panel and lists a marker typed into a chapter",
            listed && on_screen && beside_documents,
            json!({ "hits": hits }),
        );

        let line = cx.update(|cx| {
            todos
                .read(cx)
                .hits(cx)
                .into_iter()
                .find(|hit| hit.preview.contains("tighten"))
                .map(|hit| hit.line)
        });
        if let Some(line) = line {
            cx.update(|cx| {
                todos.update(cx, |_, cx| {
                    cx.emit(TodosEvent::Open {
                        path: "chapters/intro.tex".into(),
                        line,
                    })
                })
            });
        }
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).active_editor_path(cx).as_deref() == Some("chapters/intro.tex")
            })
            .await;
        steps.check(
            "a TODO row opens its file",
            line.is_some() && opened,
            json!({ "line": line }),
        );
        std::fs::write(&chapter, original)?;
        cx.update(|cx| crate::status_counters::refresh(root.to_path_buf(), cx));
        Ok(())
    }

    async fn symbol_references(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let main = root.join("main.tex");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.show_references(SymbolKind::Label, "sec:method".into(), window, cx)
            })
        })?;
        let found = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .references
                    .bar
                    .as_ref()
                    .is_some_and(|(bar, _)| bar.read(cx).occurrences.len() >= 2)
            })
            .await;
        let roles: Vec<String> = cx.update(|cx| {
            self.shell
                .read(cx)
                .references
                .bar
                .as_ref()
                .map(|(bar, _)| {
                    bar.read(cx)
                        .occurrences
                        .iter()
                        .map(|occurrence| occurrence.role.clone())
                        .collect()
                })
                .unwrap_or_default()
        });
        steps.check(
            "Find references lists a label's definition and its \\ref",
            found
                && roles.iter().any(|role| role == "definition")
                && roles.iter().any(|role| role == "reference"),
            json!({ "roles": roles }),
        );

        // Renamed through the dialog: every \ref follows, and the bar lists
        // the new name.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.begin_rename(SymbolKind::Label, "sec:method".into(), window, cx)
            })
        })?;
        self.frame_after_input(cx).await?;
        let typing = self.with_window(cx, |shell, window, cx| {
            let shell = shell.read(cx);
            let dialog = shell.references.rename.as_ref().map(|(dialog, _)| dialog);
            dialog.is_some_and(|dialog| dialog.read(cx).name_focused(window, cx))
        })?;
        steps.check(
            "the rename dialog opens with the keyboard in the name",
            typing,
            json!({}),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                let dialog = shell.references.rename.as_ref();
                if let Some(dialog) = dialog.map(|(dialog, _)| dialog.clone()) {
                    shell.submit_rename(dialog, "sec:approach".into(), window, cx);
                }
            })
        })?;
        let renamed = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let shell = shell.read(cx);
                shell.references.rename.is_none()
                    && shell
                        .references
                        .bar
                        .as_ref()
                        .is_some_and(|(bar, _)| bar.read(cx).symbol == "sec:approach")
            })
            .await;
        let text = std::fs::read_to_string(&main).unwrap_or_default();
        steps.check(
            "renaming a label rewrites its \\label and every \\ref",
            renamed
                && text.contains("\\label{sec:approach}")
                && text.contains("\\ref{sec:approach}")
                && !text.contains("sec:method"),
            json!({}),
        );
        // Back as it was, for the checks that follow.
        let root_owned = root.to_path_buf();
        cx.update(|cx| {
            crate::submission::references::rename(
                root_owned,
                SymbolKind::Label,
                "sec:approach".into(),
                "sec:method".into(),
                cx,
            )
        })
        .await
        .map_err(anyhow::Error::msg)?;
        cx.update(|cx| {
            self.shell.update(cx, |shell, cx| {
                shell.references.bar = None;
                cx.notify();
            })
        });
        Ok(())
    }

    async fn arxiv_export(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let (built, _) = self.build(cx).await?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_arxiv_export(window, cx))
        })?;
        let checked = self
            .wait_for(cx, Duration::from_secs(150), |shell, cx| {
                shell
                    .read(cx)
                    .sheets
                    .arxiv
                    .as_ref()
                    .is_some_and(|(sheet, _)| !sheet.read(cx).running())
            })
            .await;
        let rows: Vec<(String, CheckState)> = cx.update(|cx| {
            self.shell
                .read(cx)
                .sheets
                .arxiv
                .as_ref()
                .map(|(sheet, _)| {
                    sheet
                        .read(cx)
                        .rows()
                        .into_iter()
                        .map(|row| (row.label, row.state))
                        .collect()
                })
                .unwrap_or_default()
        });
        let failures = rows
            .iter()
            .filter(|(_, state)| *state == CheckState::Fail)
            .count();
        steps.check(
            "Export for arXiv checks the built paper, its .bbl and a clean build of the pack",
            built && checked && rows.len() == 5 && failures == 0,
            json!({ "rows": rows.iter().map(|(label, state)| format!("{label}: {state:?}")).collect::<Vec<_>>() }),
        );

        let zip = root.with_file_name("e2e-arxiv.zip");
        std::fs::remove_file(&zip).ok();
        cx.update(|cx| {
            if let Some(sheet) = self
                .shell
                .read(cx)
                .sheets
                .arxiv
                .as_ref()
                .map(|(sheet, _)| sheet.clone())
            {
                let zip = zip.clone();
                sheet.update(cx, |sheet, cx| sheet.export_to(zip, cx));
            }
        });
        let exported = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).sheets.arxiv.is_none()
            })
            .await;
        let size = std::fs::metadata(&zip).map(|meta| meta.len()).unwrap_or(0);
        steps.check(
            "Export ZIP writes the checked pack and closes the sheet",
            exported && size > 0,
            json!({ "bytes": size }),
        );
        std::fs::remove_file(&zip).ok();
        Ok(())
    }
}
