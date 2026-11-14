//! The e2e checks of the project's history (`crate::history`): version
//! tracking started from the History panel, a version saved under a name,
//! the panel opened from the titlebar's command into the documents' panel,
//! a version opened to read its file's changes as prose, the comparison of
//! that version with now and the export sheet over it, a restore that puts
//! the file back after asking, the activity the editor's saves recorded,
//! and a Git conflict resolved spot by spot.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::AsyncApp;
use serde_json::json;

use super::Steps;
use crate::scenario::Run;

impl Run {
    pub(super) async fn history_and_versions(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let original = std::fs::read_to_string(&chapter).context("chapters/intro.tex")?;

        // The panel, opened as the titlebar's History button opens it.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_history(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        let (on_screen, beside_documents) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let panel = shell.panel_holding("history", cx);
            let documents = shell
                .active_document(cx)
                .and_then(|key| shell.view_of_document(&key, cx))
                .and_then(|view| shell.panel_holding(&view, cx));
            (
                shell.view_on_screen("history", cx),
                panel.is_some() && panel == documents,
            )
        });
        steps.check(
            "History opens as a tool panel in the documents' panel",
            on_screen && beside_documents,
            json!({ "on_screen": on_screen }),
        );

        // Version tracking, as the panel's Enable version tracking starts it,
        // then a version saved under a name.
        let history = cx.update(|cx| self.shell.read(cx).history.clone());
        cx.update(|cx| history.update(cx, |history, cx| history.enable_tracking(cx)));
        let tracking = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                history.read(cx).versions_shown() >= 1
            })
            .await;
        let named = original.replacen("intro", "introduction", 1);
        std::fs::write(&chapter, &named)?;
        cx.update(|cx| {
            history.update(cx, |history, cx| {
                history.save_version("Draft for review".into(), cx)
            })
        });
        let saved = self
            .wait_for(cx, Duration::from_secs(15), |_, cx| {
                history
                    .read(cx)
                    .version_messages()
                    .first()
                    .map(String::as_str)
                    == Some("Draft for review")
            })
            .await;
        let messages = cx.update(|cx| history.read(cx).version_messages());
        steps.check(
            "version tracking starts and a named version is saved on the timeline",
            tracking && saved,
            json!({ "versions": messages }),
        );

        // The named version opened, its chapter read as prose.
        let read = cx.update(|cx| {
            history.update(cx, |history, cx| {
                history.open_newest_version_file_for_scenario("chapters/intro.tex", cx)
            })
        });
        let prose = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                history.read(cx).opened_passages().is_some()
            })
            .await;
        let passages = cx.update(|cx| history.read(cx).opened_passages());
        steps.check(
            "an opened version reads its file's changes as prose passages",
            read && prose && passages.is_some_and(|count| count >= 1),
            json!({ "passages": passages }),
        );

        // Compared with now, and the export sheet over the comparison.
        std::fs::write(&chapter, original.replacen("intro", "the opening", 1))?;
        self.with_window(cx, |_, window, cx| {
            history.update(cx, |history, cx| history.start_comparing(window, cx))
        })?;
        let compared = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                history.read(cx).comparison_loaded(cx)
            })
            .await;
        steps.check(
            "Compare… reads the newest named version against now",
            compared,
            json!({}),
        );
        cx.update(|cx| history.update(cx, |history, cx| history.stop_comparing(cx)));

        // Restore the project to the named version, answering the question.
        let hash = cx.update(|cx| history.read(cx).newest_version_hash());
        if let Some(hash) = hash.clone() {
            cx.update(|cx| {
                history.update(cx, |history, cx| history.restore_project(hash.clone(), cx))
            });
            self.pause(cx, Duration::from_millis(300)).await;
            let asked = self.with_window(cx, |_, window, cx| {
                let confirm = crate::confirm::install(cx);
                confirm.update(cx, |host, cx| host.accept(window, cx))
            })?;
            let restored = self
                .wait_for(cx, Duration::from_secs(15), |_, _| {
                    std::fs::read_to_string(&chapter).is_ok_and(|text| text == named)
                })
                .await;
            steps.check(
                "restoring the project to a version asks first, then puts its files back",
                asked && restored,
                json!({ "hash": hash }),
            );
        }

        // A conflict Git left, resolved spot by spot.
        let front = cx.update(|cx| {
            self.shell
                .read(cx)
                .active_editor()
                .map(|editor| editor.read(cx).path().to_path_buf())
        });
        let conflicted = root.join("conflict-check.tex");
        std::fs::write(
            &conflicted,
            "Intro.\n<<<<<<< HEAD\nOur sentence.\n=======\nTheir sentence.\n>>>>>>> feature\nOutro.\n",
        )?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_conflict_resolver("conflict-check.tex".into(), false, window, cx)
            })
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .conflict
                    .as_ref()
                    .is_some_and(|(resolver, _)| resolver.read(cx).spots() == 1)
            })
            .await;
        self.with_window(cx, |shell, _, cx| {
            if let Some(resolver) = shell
                .read(cx)
                .conflict
                .as_ref()
                .map(|(resolver, _)| resolver.clone())
            {
                resolver.update(cx, |resolver, cx| resolver.choose_and_save_for_scenario(cx));
            }
        })?;
        let resolved = self
            .wait_for(cx, Duration::from_secs(5), |_, _| {
                std::fs::read_to_string(&conflicted)
                    .is_ok_and(|text| text == "Intro.\nOur sentence.\nOutro.\n")
            })
            .await;
        let closed = cx.update(|cx| self.shell.read(cx).conflict.is_none());
        steps.check(
            "the conflict resolver keeps the chosen side and writes the file without markers",
            opened && resolved && closed,
            json!({ "text": std::fs::read_to_string(&conflicted).ok() }),
        );
        // Resolved, the file opens in front (as the Tauri app opens it);
        // its tab closes before the file goes, and the file that was in
        // front comes back for the stages after.
        let resolved_tab = cx.update(|cx| {
            self.shell
                .read(cx)
                .active_editor()
                .filter(|editor| editor.read(cx).path() == conflicted)
        });
        if let Some(editor) = resolved_tab {
            self.close_tab(cx, editor)?;
        }
        std::fs::remove_file(&conflicted).ok();
        std::fs::write(&chapter, &original)?;
        if let Some(front) = front {
            self.open(cx, &front, None)?;
        }

        self.git_merge_conflict_notice(cx, steps, root).await
    }

    /// A merge Git stops on a conflict (in the repository version tracking
    /// made) raises the window's conflict notice for that file, and the
    /// notice goes once the merge is aborted. The branch is put back where
    /// it was after.
    async fn git_merge_conflict_notice(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let git = |args: &[&str]| -> Result<std::process::Output> {
            Ok(std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=E2E",
                    "-c",
                    "user.email=e2e@example.invalid",
                ])
                .args(args)
                .current_dir(root)
                .output()?)
        };
        let text =
            |out: std::process::Output| String::from_utf8_lossy(&out.stdout).trim().to_string();
        let head = text(git(&["rev-parse", "HEAD"])?);
        let branch = text(git(&["rev-parse", "--abbrev-ref", "HEAD"])?);
        let file = "merge-check.tex";
        let path = root.join(file);
        std::fs::write(&path, "Base line.\n")?;
        git(&["add", file])?;
        git(&["commit", "-q", "-m", "merge base", "--", file])?;
        git(&["checkout", "-q", "-b", "e2e-side"])?;
        std::fs::write(&path, "Their line.\n")?;
        git(&["commit", "-q", "-m", "theirs", "--", file])?;
        git(&["checkout", "-q", &branch])?;
        std::fs::write(&path, "Our line.\n")?;
        git(&["commit", "-q", "-m", "ours", "--", file])?;
        let merge = git(&["merge", "e2e-side"])?;
        let refresh = |cx: &mut AsyncApp| {
            cx.update(|cx| {
                if let Some(project) = self.shell.read(cx).project().cloned() {
                    project.update(cx, |project, cx| project.read_git(cx));
                }
            })
        };
        refresh(cx);
        let raised = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).conflicts_noticed.contains(file)
            })
            .await;
        git(&["merge", "--abort"])?;
        refresh(cx);
        let dropped = self
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell.read(cx).conflicts_noticed.is_empty()
            })
            .await;
        steps.check(
            "a merge Git stops on raises the conflict notice, which goes once the merge is aborted",
            !merge.status.success() && raised && dropped,
            json!({
                "merge_failed": !merge.status.success(),
                // Why it stopped: a conflict, or something else (a lock).
                "merge_output": format!(
                    "{}{}",
                    String::from_utf8_lossy(&merge.stdout),
                    String::from_utf8_lossy(&merge.stderr)
                ),
                "raised": raised,
                "dropped": dropped,
            }),
        );
        git(&["reset", "-q", "--soft", &head])?;
        git(&["reset", "-q"])?;
        git(&["branch", "-q", "-D", "e2e-side"])?;
        std::fs::remove_file(&path).ok();
        Ok(())
    }
}
