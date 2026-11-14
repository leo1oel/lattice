//! The e2e checks of Overleaf (`crate::overleaf`), against a stand-in on
//! 127.0.0.1 (`scenario::overleaf_mock`), never Overleaf itself:
//!
//! - the picker, signed out, offers the sign-in; Connect opens the sign-in
//!   window on the stand-in's login page, whose cookie becomes the session,
//!   and the picker lists the account's projects (the archived one hidden);
//! - Open downloads the project into the run's scratch Overleaf Projects (the
//!   session and links kept there too, never the writer's) and opens it
//!   in a window of its own, linked, with the split Overleaf control;
//! - live mode pulls a co-author's edit on its own, and pushes one made here;
//! - an edit on both sides leaves conflict markers, and the resolver opens
//!   on the file with this computer's and Overleaf's sides;
//! - manual mode badges new work on Overleaf, and Review changes lists it
//!   and applies it;
//! - Settings › Overleaf says who is signed in and which project syncs.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result, anyhow};
use gpui::AsyncApp;
use lattice_settings::{OverleafSyncMode, SettingsTab};
use serde_json::{Value, json};

use super::Steps;
use crate::{
    scenario::{
        Run,
        overleaf_mock::{EMAIL, MockOverleaf, PROJECT_NAME},
    },
    settings,
};

const MAIN: &str =
    "\\documentclass{article}\n\\begin{document}\nA paper written on Overleaf.\n\\end{document}\n";

impl Run {
    /// These checks alone (`--scenario overleaf`), for work on Overleaf:
    /// the e2e scenario runs them too.
    pub(in crate::scenario) async fn overleaf_alone(&self, cx: &mut AsyncApp) -> Result<Value> {
        let mut steps = Steps::new(self);
        let root = self.root(cx).await?;
        self.pause(cx, Duration::from_millis(800)).await;
        self.overleaf(cx, &mut steps, &root).await?;
        steps.check_foreground(self);
        let passed = steps.0.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "overleaf", "passed": passed, "steps": steps.0 }))
    }

    pub(super) async fn overleaf(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        _root: &Path,
    ) -> Result<()> {
        // The sign-in window, the project's own window and the resolver each
        // activate a window, which takes the front unless the lab assumes
        // the key window (`Run::focused`); nothing here sends native input.
        let _front = self.focused(cx, "overleaf").await?;
        let mock =
            MockOverleaf::start(&[("main.tex", MAIN), ("refs.bib", "@misc{a, title={A}}\n")])
                .context("the Overleaf stand-in")?;
        let scratch =
            std::env::temp_dir().join(format!("lattice-gpui-overleaf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        cx.update(|cx| {
            crate::overleaf::use_stand_in_for_scenario(mock.base.clone(), scratch);
            crate::overleaf::session_changed(cx);
        });

        // The picker, signed out.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_overleaf_picker(window, cx))
        })?;
        let picker = cx
            .update(|cx| self.shell.read(cx).overleaf_picker())
            .ok_or_else(|| anyhow!("the picker did not open"))?;
        let signed_out = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                picker.read(cx).scenario_connected() == Some(false)
            })
            .await;
        steps.check(
            "Open from Overleaf, signed out, offers the sign-in",
            signed_out,
            json!({}),
        );

        // Connect: the sign-in window on the stand-in's login page.
        cx.update(|cx| picker.update(cx, |picker, cx| picker.scenario_sign_in(cx)));
        let listed = self
            .wait_for(cx, Duration::from_secs(30), |_, cx| {
                picker
                    .read(cx)
                    .scenario_projects(cx)
                    .is_some_and(|projects| !projects.is_empty())
            })
            .await;
        let projects = cx.update(|cx| picker.read(cx).scenario_projects(cx));
        let session = cx.update(|_| crate::overleaf::account::status().ok());
        steps.check(
            "signing in on Overleaf's page captures its session, and the picker lists the account's projects, the archived one hidden",
            listed
                && projects.as_deref() == Some(&[PROJECT_NAME.to_string()][..])
                && session.as_ref().is_some_and(|status| status.connected && status.email.as_deref() == Some(EMAIL)),
            json!({ "projects": projects, "connected": session.map(|status| status.connected) }),
        );

        // Open: downloaded, then opened in a window of its own.
        let opened = cx.update(|cx| {
            picker.update(cx, |picker, cx| {
                picker.scenario_open(PROJECT_NAME, false, cx)
            })
        });
        let clone_root = crate::overleaf::projects_dir()
            .map_err(|error| anyhow!(error))?
            .join(PROJECT_NAME);
        let downloaded = self
            .wait_for(cx, Duration::from_secs(30), |_, cx| {
                crate::shell::windows::shell_showing(&clone_root, cx).is_some()
            })
            .await;
        let found = cx.update(|cx| crate::shell::windows::shell_showing(&clone_root, cx));
        let on_disk = std::fs::read_to_string(clone_root.join("main.tex")).unwrap_or_default();
        // The picker's search held the keyboard; once it is gone, this window
        // keeps a focus for its shortcuts to start from.
        let focus_kept = self.with_window(cx, |_, window, cx| window.focused(cx).is_some())?;
        steps.check(
            "Open downloads the project into Overleaf Projects and opens it in a window of its own, the keyboard left with this one",
            opened && downloaded && on_disk == MAIN && focus_kept,
            json!({ "root": clone_root, "downloaded": downloaded, "focus_kept": focus_kept }),
        );
        let Some((window, shell)) = found else {
            return Ok(());
        };
        let linked = self.for_window(shell, window);
        linked.root(cx).await?;
        // Overleaf names the root folder over its live channel, which the
        // stand-in refuses; uploads need it, so it is recorded as a join
        // would record it.
        lattice_core::overleaf::set_realtime_metadata(&clone_root, "root-mock", "owner")
            .map_err(|error| anyhow!(error))?;

        let control = linked
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                let bridge = shell.read(cx).overleaf.read(cx);
                bridge
                    .link()
                    .is_some_and(|link| link.project_name == PROJECT_NAME)
            })
            .await;
        steps.check(
            "the project opens linked to Overleaf, with the split sync control",
            control,
            json!({}),
        );

        // Live mode pulls a co-author's edit on its own.
        let theirs = MAIN.replace("A paper", "A shared paper");
        mock.edit("main.tex", &theirs);
        let pulled = linked
            .wait_for(cx, Duration::from_secs(40), |_, _| {
                std::fs::read_to_string(clone_root.join("main.tex"))
                    .is_ok_and(|text| text == theirs)
            })
            .await;
        steps.check(
            "live mode pulls a co-author's edit on its own",
            pulled,
            json!({ "version": mock.version() }),
        );

        // And pushes one made here, after the writer pauses.
        let ours = theirs.replace("\\end{document}", "Our new paragraph.\n\\end{document}");
        std::fs::write(clone_root.join("main.tex"), &ours)?;
        let pushed = linked
            .wait_for(cx, Duration::from_secs(45), |_, _| {
                mock.file("main.tex").as_deref() == Some(ours.as_str())
            })
            .await;
        steps.check(
            "live mode pushes an edit made here once the writer pauses",
            pushed,
            json!({ "uploads": mock.requests("POST /project/proj-mock/upload") }),
        );

        // An edit on both sides of one line: markers, and the resolver.
        let settled = linked
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                !shell.read(cx).overleaf.read(cx).syncing()
            })
            .await;
        mock.edit("main.tex", &ours.replace("A shared paper", "Their paper"));
        std::fs::write(
            clone_root.join("main.tex"),
            ours.replace("A shared paper", "Our paper"),
        )?;
        let resolving = linked
            .wait_for(cx, Duration::from_secs(60), |shell, cx| {
                shell
                    .read(cx)
                    .conflict
                    .as_ref()
                    .is_some_and(|(resolver, _)| resolver.read(cx).is_overleaf())
            })
            .await;
        let marked = std::fs::read_to_string(clone_root.join("main.tex"))
            .is_ok_and(|text| text.contains("<<<<<<<"));
        steps.check(
            "an edit on both sides leaves markers, and the resolver opens with this computer's and Overleaf's sides",
            settled && resolving && marked,
            json!({ "marked": marked }),
        );
        let resolver = cx.update(|cx| {
            linked
                .shell
                .read(cx)
                .conflict
                .as_ref()
                .map(|(resolver, _)| resolver.clone())
        });
        if let Some(resolver) = resolver {
            cx.update(|cx| {
                resolver.update(cx, |resolver, cx| resolver.choose_and_save_for_scenario(cx))
            });
            linked
                .wait_for(cx, Duration::from_secs(10), |_, _| {
                    std::fs::read_to_string(clone_root.join("main.tex"))
                        .is_ok_and(|text| !text.contains("<<<<<<<"))
                })
                .await;
        }

        // Manual mode: a badge for new work, then Review changes.
        cx.update(|cx| settings::update(cx, |s| s.overleaf_sync_mode = OverleafSyncMode::Manual));
        linked
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                !shell.read(cx).overleaf.read(cx).syncing()
            })
            .await;
        let before_review = mock.file("main.tex").unwrap_or_default();
        let incoming = format!("{before_review}% A note from Overleaf\n");
        mock.edit("main.tex", &incoming);
        // The badge's check runs as manual mode starts, then every 30 s; the
        // mode is toggled to check now.
        cx.update(|cx| settings::update(cx, |s| s.overleaf_sync_mode = OverleafSyncMode::Live));
        cx.update(|cx| settings::update(cx, |s| s.overleaf_sync_mode = OverleafSyncMode::Manual));
        let badged = linked
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).overleaf.read(cx).remote_changes()
            })
            .await;
        linked.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.sync_overleaf(window, cx))
        })?;
        let review = cx.update(|cx| linked.shell.read(cx).overleaf_review());
        let summary = match &review {
            Some(review) => {
                linked
                    .wait_for(cx, Duration::from_secs(30), |_, cx| {
                        review.read(cx).scenario_summary().is_some()
                    })
                    .await;
                cx.update(|cx| review.read(cx).scenario_summary())
            }
            None => None,
        };
        if let Some(review) = &review {
            cx.update(|cx| review.update(cx, |review, cx| review.scenario_apply(cx)));
        }
        let applied = linked
            .wait_for(cx, Duration::from_secs(40), |_, _| {
                std::fs::read_to_string(clone_root.join("main.tex"))
                    .is_ok_and(|text| text.contains("A note from Overleaf"))
            })
            .await;
        steps.check(
            "manual mode badges new work on Overleaf, and Review changes lists it, then applies it",
            badged && summary.as_deref() == Some("1 file would change") && applied,
            json!({ "badged": badged, "summary": summary, "applied": applied }),
        );
        cx.update(|cx| settings::update(cx, |s| s.overleaf_sync_mode = OverleafSyncMode::Live));

        // Settings › Overleaf.
        linked.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.open_settings(Some(SettingsTab::Overleaf), window, cx)
            })
        })?;
        linked.pause(cx, Duration::from_millis(300)).await;
        let read = linked
            .wait_for(cx, Duration::from_secs(10), |shell, cx| {
                shell
                    .read(cx)
                    .settings
                    .as_ref()
                    .and_then(|settings| settings.read(cx).overleaf_connection())
                    .is_some_and(|connection| connection.read(cx).scenario_state().is_some())
            })
            .await;
        let state = cx.update(|cx| {
            linked
                .shell
                .read(cx)
                .settings
                .as_ref()
                .and_then(|settings| settings.read(cx).overleaf_connection())
                .and_then(|connection| connection.read(cx).scenario_state())
        });
        steps.check(
            "Settings › Overleaf says who is signed in and which project this one syncs with",
            read && state.as_ref().is_some_and(|(status, link)| {
                status.email.as_deref() == Some(EMAIL)
                    && link
                        .as_ref()
                        .is_some_and(|link| link.project_name == PROJECT_NAME)
            }),
            json!({ "email": state.as_ref().and_then(|(status, _)| status.email.clone()) }),
        );

        window
            .update(cx, |_, window, _| window.remove_window())
            .ok();
        cx.update(|cx| {
            self.shell.update(cx, |shell, cx| {
                shell
                    .overleaf
                    .update(cx, |bridge, cx| bridge.reload_link(cx))
            })
        });
        Ok(())
    }
}
