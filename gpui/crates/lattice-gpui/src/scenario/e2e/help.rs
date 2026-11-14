//! The e2e checks of the app's log and Help (`crate::app_log`,
//! `crate::help`): the scenario's builds logged as operations; a notice the
//! window shows logged with its source; Settings › Logs listing it, its level
//! filter and search narrowing the list, and its export keeping the notice's
//! text out unless raw text is asked for; Report a problem saving that
//! redacted export and building a form address that carries only versions
//! (the browser and Finder are not opened); What's new opening from Help's
//! action at the running version, paging to an older release and closing;
//! and Clear emptying the log.

use std::time::Duration;

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{
    app_log::{self, Level},
    help::whats_new::{RUNNING_VERSION, release_notes},
    notices::{self, Notice},
    scenario::Run,
    settings::logs_pane::LogsPane,
    shell::WhatsNew,
};

/// What the logged notice says: a path that must not leave the Mac.
const DETAIL: &str = "Undefined control sequence in /Users/someone/secret-paper.tex";

impl Run {
    pub(super) async fn help_and_logs(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        // The scenario has built the fixture by now: each build is one
        // operation, its start and its success under one id.
        let entries = cx.update(|cx| app_log::global(cx).read(cx).entries().to_vec());
        let succeeded = entries.iter().find(|entry| {
            entry.title.starts_with("Build succeeded in")
                && entry.context.as_ref().is_some_and(|context| {
                    context.operation == "Build"
                        && context.phase == "completed"
                        && context.outcome.as_deref() == Some("success")
                        && context.duration_ms.is_some()
                })
        });
        // The start is matched by its operation id, not its English title:
        // the start's action is worded in the interface language of the
        // moment, and the spelling checks before this switch to Simplified
        // Chinese while their edits start a build, which can end in English
        // ("▶ 构建", then "Build succeeded in …" under one id).
        let started = succeeded.and_then(|done| {
            let id = &done.context.as_ref()?.operation_id;
            entries.iter().find(|entry| {
                entry.title.starts_with("▶ ")
                    && entry.context.as_ref().is_some_and(|context| {
                        &context.operation_id == id && context.phase == "started"
                    })
            })
        });
        steps.check(
            "a build is logged as one operation: its start, then its success with its time",
            succeeded.is_some() && started.is_some(),
            json!({ "succeeded": succeeded.map(|entry| &entry.title), "started": started.is_some() }),
        );
        cx.update(|cx| {
            notices::show(
                Notice::new(
                    lattice_ui::components::ToastLevel::Error,
                    "E2E build failed",
                )
                .source("E2E")
                .detail(DETAIL),
                cx,
            )
        });
        let newest = cx.update(|cx| app_log::global(cx).read(cx).entries().first().cloned());
        steps.check(
            "a notice the window shows is logged, newest first, with its source and level",
            newest.as_ref().is_some_and(|entry| {
                entry.title == "E2E build failed"
                    && entry.source == "E2E"
                    && entry.level == Level::Error
                    && entry.detail == DETAIL
            }),
            json!({ "newest": newest.as_ref().map(|entry| (&entry.source, &entry.title)) }),
        );
        self.logs_page(cx, steps).await?;
        self.report_saved(cx, steps).await?;
        self.whats_new(cx, steps).await?;
        self.queued_build_logged(cx, steps).await?;
        self.logs_follow_at_cap(cx, steps).await?;
        cx.update(|cx| app_log::global(cx).update(cx, |log, cx| log.clear(cx)));
        let cleared = cx.update(|cx| app_log::global(cx).read(cx).entries().is_empty());
        steps.check(
            "Clear empties the log",
            cleared,
            json!({ "cleared": cleared }),
        );
        Ok(())
    }

    async fn logs_page(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(lattice_settings::SettingsTab::Logs), window, cx)
            })
        })?;
        let opened = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).settings.is_some()
            })
            .await;
        let pane: Option<Entity<LogsPane>> = cx.update(|cx| {
            self.shell
                .read(cx)
                .settings
                .as_ref()
                .map(|settings| settings.read(cx).logs.clone())
        });
        let Some(pane) = pane else {
            steps.check("Settings opens on Logs", false, json!({ "opened": opened }));
            return Ok(());
        };
        let titles = |cx: &mut AsyncApp| -> Vec<String> {
            cx.update(|cx| {
                pane.read(cx)
                    .visible(cx)
                    .into_iter()
                    .map(|group| group.summary.title)
                    .collect()
            })
        };
        let listed = titles(cx).iter().any(|title| title == "E2E build failed");
        cx.update(|cx| pane.update(cx, |pane, cx| pane.set_level(Some(Level::Info), cx)));
        let at_info = titles(cx);
        cx.update(|cx| pane.update(cx, |pane, cx| pane.set_level(None, cx)));
        self.with_window(cx, |_, window, cx| {
            pane.update(cx, |pane, cx| pane.set_query("SECRET-PAPER", window, cx))
        })?;
        let searched = titles(cx);
        steps.check(
            "Settings › Logs lists the notice; its level filter and search narrow the list",
            opened
                && listed
                && !at_info.iter().any(|title| title == "E2E build failed")
                && searched == ["E2E build failed"],
            json!({ "listed": listed, "atInfo": at_info.len(), "searched": searched }),
        );

        let entries = cx.update(|cx| {
            pane.read(cx)
                .visible(cx)
                .into_iter()
                .flat_map(|group| group.entries)
                .collect::<Vec<_>>()
        });
        self.with_window(cx, |_, window, cx| {
            pane.update(cx, |pane, cx| pane.open_export(entries, window, cx))
        })?;
        let dialog = cx.update(|cx| pane.read(cx).export_dialog().cloned());
        let (safe, raw) = match &dialog {
            Some(dialog) => {
                let safe = cx.update(|cx| dialog.read(cx).text());
                cx.update(|cx| dialog.update(cx, |dialog, cx| dialog.set_include_raw(true, cx)));
                let raw = cx.update(|cx| dialog.read(cx).text());
                (safe, raw)
            }
            None => (String::new(), String::new()),
        };
        let parsed: serde_json::Value = serde_json::from_str(&safe).unwrap_or_default();
        steps.check(
            "Export… keeps the notice's text out of the JSON unless raw text is asked for",
            parsed["schema_version"] == 1
                && parsed["entries"].as_array().is_some_and(|entries| entries.len() == 1)
                && parsed["entries"][0]["level"] == "error"
                && !safe.contains("secret-paper")
                && raw.contains("secret-paper"),
            json!({ "safeEntries": parsed["entries"], "rawHasDetail": raw.contains("secret-paper") }),
        );
        if let Some(dialog) = dialog {
            cx.update(|cx| {
                dialog.update(cx, |_, cx| {
                    cx.emit(crate::settings::logs_export::ExportEvent::Close)
                })
            });
        }
        self.with_window(cx, |_, window, cx| {
            pane.update(cx, |pane, cx| pane.set_query("", window, cx))
        })?;
        self.with_window(cx, |shell, _, cx| {
            if let Some(settings) = shell.read(cx).settings.clone() {
                settings.update(cx, |_, cx| cx.emit(crate::settings::SettingsEvent::Close));
            }
        })?;
        Ok(())
    }

    async fn report_saved(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let task = cx.update(crate::help::report::save_report);
        let saved = task.await;
        let (contents, url) = match &saved {
            Ok(saved) => (
                std::fs::read_to_string(&saved.path).unwrap_or_default(),
                saved.issue_url.clone(),
            ),
            Err(_) => (String::new(), String::new()),
        };
        let exported: serde_json::Value = serde_json::from_str(&contents).unwrap_or_default();
        steps.check(
            "Report a problem saves the redacted export and opens a form that carries only versions",
            exported["includes_raw_diagnostic"] == false
                && exported["entries"].as_array().is_some_and(|entries| !entries.is_empty())
                && !contents.contains("secret-paper")
                && url.starts_with("https://github.com/leo1oel/lattice/issues/new?template=bug_report.yml")
                && url.contains(&format!("lattice-version={RUNNING_VERSION}"))
                && url.contains("macos-version=macOS+")
                && !url.contains("secret")
                && !url.contains("E2E"),
            json!({ "saved": saved.as_ref().map(|saved| saved.path.display().to_string()).map_err(Clone::clone), "url": url }),
        );
        if let Ok(saved) = saved {
            std::fs::remove_file(saved.path).ok();
        }
        Ok(())
    }

    /// Two builds asked for at once: the second waits behind the first, and
    /// its operation opens with the trigger "queued" (the Tauri pipeline's
    /// `logAction(t`Build`, t`Build`, t`queued`)`), while the first, which
    /// waited for nothing, carries no trigger.
    async fn queued_build_logged(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        // A build an earlier step left running would make both asks wait
        // behind it, as one queued pass: start from no build.
        let idle = self
            .wait_for(cx, Duration::from_secs(180), |shell, cx| !shell.read(cx).building())
            .await;
        let before = self.builds(cx);
        // The log may be full (300) by now, so new entries are those above
        // the newest one before, not a count's growth.
        let previous = cx.update(|cx| {
            app_log::global(cx).read(cx).entries().first().map(|entry| entry.id.clone())
        });
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.build(&crate::shell::Build, window, cx);
                shell.build(&crate::shell::Build, window, cx);
            })
        })?;
        let built = self.built_after(cx, before + 1).await;
        let queued = lattice_i18n::t!("queued").to_string();
        // Newest first: the queued pass's start, then the first one's.
        let entries = cx.update(|cx| app_log::global(cx).read(cx).entries().to_vec());
        let starts: Vec<Option<String>> = entries
            .iter()
            .take_while(|entry| Some(&entry.id) != previous.as_ref())
            .filter_map(|entry| entry.context.as_ref())
            .filter(|context| context.operation == "Build" && context.phase == "started")
            .map(|context| context.trigger.clone())
            .collect();
        steps.check(
            "a build asked for while another runs is logged with the trigger \"queued\"; the first carries none",
            idle && built && starts == [Some(queued.clone()), None],
            json!({ "idle": idle, "built": built, "starts": starts, "builds": self.builds(cx) - before }),
        );
        Ok(())
    }

    /// Settings › Logs with the log full (300 entries): the reader at the
    /// bottom keeps seeing the newest entry when new ones push the oldest
    /// out, though the count stays 300. The oldest ten are one operation (one
    /// row), so ten notices replacing them grow the list by nine rows.
    async fn logs_follow_at_cap(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let notice = |title: String| app_log::NewEntry {
            level: Level::Info,
            source: "E2E".into(),
            title,
            detail: String::new(),
            context: None,
        };
        cx.update(|cx| {
            app_log::global(cx).update(cx, |log, cx| {
                log.clear(cx);
                for step in 0..10 {
                    let context = app_log::OperationContext {
                        operation_id: "e2e-oldest-operation".into(),
                        operation: "Build".into(),
                        phase: if step == 0 { "started" } else { "progress" }.into(),
                        ..Default::default()
                    };
                    let entry = app_log::NewEntry {
                        context: Some(context),
                        ..notice(format!("Oldest step {step}"))
                    };
                    log.add(entry, None, false, cx);
                }
                for n in 0..290 {
                    log.add(notice(format!("Filler notice {n}")), None, false, cx);
                }
            })
        });
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(lattice_settings::SettingsTab::Logs), window, cx)
            })
        })?;
        let pane: Option<Entity<LogsPane>> = cx.update(|cx| {
            self.shell
                .read(cx)
                .settings
                .as_ref()
                .map(|settings| settings.read(cx).logs.clone())
        });
        let Some(pane) = pane else {
            steps.check("Settings opens on Logs at the cap", false, json!({}));
            return Ok(());
        };
        self.draw_frames(cx).await?;
        let first = cx.update(|cx| pane.read(cx).scroll_extent());
        cx.update(|cx| {
            app_log::global(cx).update(cx, |log, cx| {
                for n in 0..10 {
                    log.add(notice(format!("Newest notice {n}")), None, false, cx);
                }
            })
        });
        self.draw_frames(cx).await?;
        let after = cx.update(|cx| pane.read(cx).scroll_extent());
        let (count, newest_shown) = cx.update(|cx| {
            let groups = pane.read(cx).visible(cx);
            let count: usize = groups.iter().map(|group| group.entries.len()).sum();
            let last = groups.last().map(|group| group.summary.title.clone());
            (count, last)
        });
        let slack = gpui::px(2.);
        steps.check(
            "Settings › Logs keeps following the newest entry once the log is full at 300",
            count == 300
                && first.1 > gpui::px(0.)
                && first.0 < slack
                && after.1 > first.1
                && after.0 < slack
                && newest_shown.as_deref() == Some("Newest notice 9"),
            json!({
                "count": count,
                "before": { "fromBottom": f32::from(first.0), "max": f32::from(first.1) },
                "after": { "fromBottom": f32::from(after.0), "max": f32::from(after.1) },
                "newestShown": newest_shown,
            }),
        );
        self.with_window(cx, |shell, _, cx| {
            if let Some(settings) = shell.read(cx).settings.clone() {
                settings.update(cx, |_, cx| cx.emit(crate::settings::SettingsEvent::Close));
            }
        })?;
        Ok(())
    }

    /// Draw a few frames: the log's scroll extent is that of the last one,
    /// and a covered window draws none of its own.
    async fn draw_frames(&self, cx: &mut AsyncApp) -> Result<()> {
        for _ in 0..3 {
            self.with_window(cx, |_, window, _cx| {
                window.refresh();
                #[cfg(feature = "offscreen-shots")]
                let _ = window.draw(_cx);
            })?;
            crate::scenario::sleep(cx, Duration::from_millis(80)).await;
        }
        Ok(())
    }

    async fn whats_new(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(Box::new(WhatsNew), cx)
        })?;
        let sheet = cx.update(|cx| {
            self.shell
                .read(cx)
                .sheets
                .whats_new
                .as_ref()
                .map(|(sheet, _)| sheet.clone())
        });
        let notes = release_notes(RUNNING_VERSION);
        let first = cx.update(|cx| {
            sheet
                .as_ref()
                .map(|sheet| sheet.read(cx).shown_version().to_string())
        });
        if let Some(sheet) = &sheet {
            cx.update(|cx| sheet.update(cx, |sheet, cx| sheet.step(1, cx)));
        }
        let older = cx.update(|cx| {
            sheet
                .as_ref()
                .map(|sheet| sheet.read(cx).shown_version().to_string())
        });
        steps.check(
            "What's new opens from Help at the running version's notes and pages to an older release",
            first.as_deref() == notes.first().map(|notes| notes.version.as_str())
                && (notes.len() < 2 || older.as_deref() == Some(notes[1].version.as_str())),
            json!({ "first": first, "older": older, "bundled": notes.len() }),
        );
        if let Some(sheet) = sheet {
            cx.update(|cx| {
                sheet.update(cx, |_, cx| {
                    cx.emit(crate::help::whats_new::WhatsNewEvent::Close)
                })
            });
        }
        let closed = cx.update(|cx| self.shell.read(cx).sheets.whats_new.is_none());
        steps.check(
            "Done closes What's new",
            closed,
            json!({ "closed": closed }),
        );
        Ok(())
    }
}
