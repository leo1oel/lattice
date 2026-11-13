//! The e2e checks for the project's search surfaces and the ways into a
//! project: quick open by name, at a line and by section; Find in project
//! stepping to a hit; Replace in project rewriting a file the editor then
//! shows; the New project dialog; and the welcome screen of a window
//! without a project, listing the project this run opened.

use std::{path::Path, time::Duration};

use anyhow::{Result, anyhow};
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{
    scenario::Run,
    search::quick_open::QuickOpen,
    shell::{
        Shell,
        commands::{FindInProject, NewProject, ReplaceInProject},
    },
};

impl Run {
    pub(super) async fn documents_and_project(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        // A part that cannot go on is a failed step, not the end of the run.
        if let Err(error) = self.quick_open_steps(cx, steps, root).await {
            steps.check(
                "quick open",
                false,
                json!({ "error": format!("{error:#}") }),
            );
        }
        if let Err(error) = self.find_steps(cx, steps).await {
            steps.check(
                "Find in project",
                false,
                json!({ "error": format!("{error:#}") }),
            );
        }
        if let Err(error) = self.replace_steps(cx, steps, root).await {
            steps.check(
                "Replace in project",
                false,
                json!({ "error": format!("{error:#}") }),
            );
        }
        if let Err(error) = self.new_project_and_welcome(cx, steps).await {
            steps.check(
                "New project and the welcome screen",
                false,
                json!({ "error": format!("{error:#}") }),
            );
        }
        Ok(())
    }

    fn quick_open_view(&self, cx: &mut AsyncApp) -> Option<Entity<QuickOpen>> {
        cx.update(|cx| self.shell.read(cx).quick_open().cloned())
    }

    /// Open quick open with ⌘P, type `query` with native keys, and wait for
    /// its rows.
    async fn quick_open_query(&self, cx: &mut AsyncApp, query: &str) -> Result<Vec<String>> {
        self.press(cx, 'p', true).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let view = self
            .quick_open_view(cx)
            .ok_or_else(|| anyhow!("⌘P opened no quick open"))?;
        self.type_text(cx, query).await?;
        self.wait_for(cx, Duration::from_secs(8), |_, cx| {
            !view.read(cx).reading_symbols() && !view.read(cx).row_texts().is_empty()
        })
        .await;
        Ok(cx.update(|cx| view.read(cx).row_texts()))
    }

    fn quick_open_confirm(&self, cx: &mut AsyncApp) -> Result<()> {
        let Some(view) = self.quick_open_view(cx) else {
            return Ok(());
        };
        self.with_window(cx, |_, window, cx| {
            view.update(cx, |view, cx| view.confirm(window, cx))
        })
    }

    async fn quick_open_steps(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        // main.tex on screen, so chapters/intro.tex (visited earlier) leads
        // the empty query's Recent.
        self.open(cx, &root.join("main.tex"), Some(1))?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.press(cx, 'p', true).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let recent = self
            .quick_open_view(cx)
            .map(|view| cx.update(|cx| view.read(cx).row_texts()))
            .unwrap_or_default();
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        steps.check(
            "⌘P lists the files visited this session first, without the one on screen",
            recent.first().map(String::as_str) == Some("chapters/intro.tex")
                && !recent.iter().take(3).any(|row| row == "main.tex"),
            json!({ "rows": recent.iter().take(8).collect::<Vec<_>>() }),
        );

        let rows = self.quick_open_query(cx, "intro").await?;
        self.quick_open_confirm(cx)?;
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                let shell = shell.read(cx);
                shell.quick_open().is_none()
                    && shell.active_editor_path(cx).as_deref() == Some("chapters/intro.tex")
            })
            .await;
        steps.check(
            "quick open ranks a typed name first and ↩ opens it",
            opened && rows.first().map(String::as_str) == Some("chapters/intro.tex"),
            json!({ "rows": rows }),
        );

        let rows = self.quick_open_query(cx, ":3").await?;
        self.quick_open_confirm(cx)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let editor = self.open(cx, &root.join("chapters/intro.tex"), None)?;
        let row = self.cursor_row(cx, &editor);
        steps.check(
            "quick open's :3 goes to line 3 of the file on screen",
            rows == [":3"] && row == 2,
            json!({ "rows": rows, "row": row }),
        );

        let rows = self.quick_open_query(cx, "@method").await?;
        self.quick_open_confirm(cx)?;
        let jumped = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).active_editor_path(cx).as_deref() == Some("main.tex")
            })
            .await;
        steps.check(
            "quick open's @ lists the sections and labels, and goes to one",
            jumped
                && rows.iter().any(|row| row == "@Method")
                && rows.iter().any(|row| row == "@sec:method"),
            json!({ "rows": rows }),
        );
        Ok(())
    }

    async fn find_steps(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(Box::new(FindInProject), cx)
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let find = cx
            .update(|cx| self.shell.read(cx).project_find().cloned())
            .ok_or_else(|| anyhow!("Find in project did not open"))?;
        self.type_text(cx, "introduces").await?;
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            find.read(cx)
                .shown_hits(cx)
                .is_some_and(|hits| !hits.is_empty())
        })
        .await;
        let hits = cx
            .update(|cx| find.read(cx).shown_hits(cx))
            .unwrap_or_default();
        self.with_window(cx, |_, window, cx| {
            find.update(cx, |find, cx| find.next_hit(window, cx))
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).active_editor_path(cx).as_deref() == Some("chapters/intro.tex")
            })
            .await;
        // The sheet stays for the next F3; ⎋ closes it and keeps the query.
        let stays = cx.update(|cx| self.shell.read(cx).project_find().is_some());
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_document_overlays(window, cx))
        })?;
        steps.check(
            "Find in project finds a line across the project and F3 opens it, the sheet staying",
            opened && stays && hits.iter().any(|hit| hit == "chapters/intro.tex:2"),
            json!({ "hits": hits }),
        );
        Ok(())
    }

    async fn replace_steps(&self, cx: &mut AsyncApp, steps: &mut Steps, root: &Path) -> Result<()> {
        let file = root.join("chapters/replace-check.tex");
        std::fs::write(&file, "Before lattice-token and lattice-token.\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.with_window(cx, |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(Box::new(ReplaceInProject), cx)
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let replace = cx
            .update(|cx| self.shell.read(cx).project_replace().cloned())
            .ok_or_else(|| anyhow!("Replace in project did not open"))?;
        self.with_window(cx, |_, window, cx| {
            replace.update(cx, |replace, cx| {
                replace.fill("lattice-token", "woven", window, cx)
            })
        })?;
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            replace.read(cx).previewed(cx).is_some()
        })
        .await;
        let previewed = cx.update(|cx| replace.read(cx).previewed(cx));
        cx.update(|cx| replace.update(cx, |replace, cx| replace.replace(cx)));
        let replaced = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).project_replace().is_none()
                    && std::fs::read_to_string(&file)
                        .is_ok_and(|text| text == "Before woven and woven.\n")
                    && editor.read(cx).editor().read(cx).text(cx) == "Before woven and woven.\n"
            })
            .await;
        steps.check(
            "Replace in project previews the matches, rewrites them on disk and the open editor shows it",
            previewed == Some(2) && replaced,
            json!({ "previewed": previewed, "disk": std::fs::read_to_string(&file).ok() }),
        );
        std::fs::remove_file(&file).ok();
        Ok(())
    }

    async fn new_project_and_welcome(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(Box::new(NewProject), cx)
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let shown = cx.update(|cx| self.shell.read(cx).new_project_dialog().is_some());
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.dismiss_new_project(window, cx))
        })?;
        let gone = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                shell.read(cx).new_project_dialog().is_none()
            })
            .await;
        steps.check(
            "⌘⇧N opens New project, which closes again",
            shown && gone,
            json!({}),
        );

        // A window without a project shows the welcome screen, its desk
        // listing the project this run opened.
        let name = cx.update(|cx| self.shell.read(cx).project_name(cx).to_string());
        let (window, shell) = cx.update(|cx| Shell::open_window(None, cx))?;
        let second = Run { shell, window };
        second.pause(cx, Duration::from_millis(400)).await;
        let desk = cx.update(|cx| {
            second
                .shell
                .read(cx)
                .welcome()
                .map(|welcome| welcome.read(cx).desk_names(cx))
        });
        second
            .with_window(cx, |_, window, _| window.remove_window())
            .ok();
        steps.check(
            "a window without a project shows the welcome screen with the recent projects",
            desk.as_ref()
                .is_some_and(|desk| desk.first() == Some(&name)),
            json!({ "desk": desk, "project": name }),
        );
        Ok(())
    }
}
