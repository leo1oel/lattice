//! The build's surfaces, end to end: the Build button's sequence, the
//! diagnostics card over the PDF with TeX's message explained and its fix
//! applied, the unattended rebuild that restates an unchanged failure, the
//! missing-package install, clean and clean rebuild, stopping a build that
//! loops, the TeX doctor, the setup wizard and the manuscript word count.
//!
//! lattice-core's doctor and installers are replaced by a stand-in
//! (`tex_setup::backend::StubTexSetup`): nothing here runs a real install or
//! anything privileged.
//!
//! On macOS, `LATTICE_E2E_SHOTS=DIR` saves each surface as it shows (the
//! Build button's card, the diagnostics card, the package chooser, the TeX
//! doctor, the setup wizard) into DIR, for a look review; a build with
//! `offscreen-shots` draws them itself, so the screen may be locked.

use std::{path::Path, sync::Arc, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _};
use serde_json::json;

use super::Steps;
use crate::{
    build::{
        diagnostics,
        tex_setup::backend::{StubTexSetup, TexSetupGlobal},
    },
    build_panel::BuildAction,
    scenario::Run,
    shell::{CleanBuildFiles, CleanRebuild, InstallLatexTools, OpenTexDoctor, StopBuild},
};

/// A package no TeX distribution has, which the stand-in "installs".
const MISSING_PACKAGE: &str = "latticee2emissing";

impl Run {
    /// Replace the installers with the stand-in before anything can reach
    /// them, its doctor reporting a complete setup.
    pub(super) fn stub_tex_setup(&self, cx: &mut AsyncApp, root: &Path) -> Arc<StubTexSetup> {
        let stub = Arc::new(StubTexSetup::new(
            root.to_path_buf(),
            vec![StubTexSetup::report(&[])],
            vec!["lattice-e2e-a".into(), "lattice-e2e-b".into()],
        ));
        let global = TexSetupGlobal(stub.clone());
        cx.update(|cx| cx.set_global(global));
        stub
    }

    /// Save the window as `name`.png into `LATTICE_E2E_SHOTS`, when set.
    async fn snapshot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(target_os = "macos")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            let out = Path::new(&dir).join(format!("{name}.png"));
            if let Err(error) = self.capture(cx, &out.to_string_lossy()).await {
                log::warn!("e2e shot {name}: {error:#}");
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (cx, name);
    }

    /// Hover the Build button until its card shows, and save it.
    async fn snapshot_build_card(&self, cx: &mut AsyncApp) -> Result<()> {
        if std::env::var_os("LATTICE_E2E_SHOTS").is_none() {
            return Ok(());
        }
        let Some(chip) = lattice_ui::parity::regions()
            .get("build-chip")
            .and_then(|region| region.bounds)
        else {
            return Ok(());
        };
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(
                gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                    position: chip.center(),
                    pressed_button: None,
                    modifiers: gpui::Modifiers::default(),
                }),
                cx,
            );
        })?;
        self.pause(cx, Duration::from_millis(700)).await;
        self.snapshot(cx, "build-card").await;
        Ok(())
    }

    /// Send `action` to the shell's own node rather than to the window's
    /// focus. A window routes an action through the focus path of the last
    /// frame it drew and falls back to its root, which holds none of the
    /// shell's handlers: after the package chooser closes, focus is not in
    /// the shell's path, and an idle window on the macOS runner may draw no
    /// frame before the dispatch, so Clean, Stop and the rest reached
    /// nothing there. The shell's node is in every frame since the first.
    fn dispatch_to_shell(&self, cx: &mut AsyncApp, action: &dyn gpui::Action) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            let focus = shell.read(cx).focus_handle(cx);
            focus.dispatch_action(action, window, cx)
        })
    }

    fn builds(&self, cx: &mut AsyncApp) -> usize {
        cx.update(|cx| self.shell.read(cx).build_panel().read(cx).builds())
    }

    /// Wait for a build after the `before`th to finish, with nothing queued.
    async fn built_after(&self, cx: &mut AsyncApp, before: usize) -> bool {
        self.wait_for(cx, Duration::from_secs(180), |shell, cx| {
            let shell = shell.read(cx);
            !shell.building() && shell.build_panel().read(cx).builds() > before
        })
        .await
    }

    /// Rewrite `path`, which is open in an editor, as an edit made outside
    /// Lattice, and wait for the build its reload starts to settle. The file
    /// watcher picks when that reload lands, so a build started here at once
    /// may settle first and leave the reload's own build running into the
    /// next step, where a Clean then finds the build files busy and does
    /// nothing. Builds here only when no reload build comes.
    async fn rewrite_open_file(&self, cx: &mut AsyncApp, path: &Path, text: &str) -> Result<bool> {
        let before = self.builds(cx);
        std::fs::write(path, text)?;
        let started = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                let shell = shell.read(cx);
                shell.building() || shell.build_panel().read(cx).builds() > before
            })
            .await;
        if !started {
            self.build(cx).await.ok();
        }
        Ok(self.built_after(cx, before).await)
    }

    /// After the first, clean build: the Build button's card lists the
    /// passes latexmk ran, and the status bar counts the manuscript.
    pub(super) async fn sequence_and_words(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        let passes: Vec<String> = cx.update(|cx| {
            self.shell
                .read(cx)
                .build_panel()
                .read(cx)
                .outcome()
                .map(|outcome| {
                    outcome
                        .steps
                        .iter()
                        .map(|step| format!("{} {}", step.tool, step.run))
                        .collect()
                })
                .unwrap_or_default()
        });
        steps.check(
            "the Build button's card lists the passes latexmk ran",
            passes.iter().any(|pass| pass.contains("latex")),
            json!({ "passes": passes }),
        );
        let counted = self
            .wait_for(cx, Duration::from_secs(20), |shell, cx| {
                shell.read(cx).words().read(cx).count().is_some()
            })
            .await;
        let count = cx.update(|cx| {
            self.shell
                .read(cx)
                .words()
                .read(cx)
                .count()
                .map(|count| (count.total, count.source.clone()))
        });
        steps.check(
            "the status bar counts the manuscript's words (TeXcount, or an estimate without it)",
            counted && count.as_ref().is_some_and(|(total, _)| *total > 0),
            json!({ "count": count }),
        );
        self.snapshot_build_card(cx).await
    }

    /// After the broken build: the card floats over the PDF with the error
    /// explained, and an unattended rebuild restates it without typesetting.
    pub(super) async fn explained_failure(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
    ) -> Result<()> {
        let card = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            let last = panel.last()?;
            let ix = last
                .diagnostics
                .iter()
                .position(|diagnostic| diagnostic.level == "error")?;
            let explained = last.explained.get(ix).cloned().flatten();
            Some((
                panel.card_shown(),
                panel.docked(),
                panel.expanded,
                explained
                    .as_ref()
                    .map(|explained| explained.headline.clone()),
                explained.as_ref().and_then(|explained| {
                    explained
                        .excerpt
                        .iter()
                        .find(|line| line.failing)
                        .and_then(|line| {
                            line.token.map(|(start, end)| {
                                (line.number, line.text[start..end].to_string())
                            })
                        })
                }),
            ))
        });
        let explained = card
            .as_ref()
            .is_some_and(|(shown, docked, expanded, headline, marked)| {
                *shown
                    && !docked
                    && *expanded
                    && headline.as_deref() == Some("Unknown command \\undefinedmacro")
                    && marked
                        .as_ref()
                        .is_some_and(|(line, token)| *line == 3 && token == "\\undefinedmacro")
            });
        steps.check(
            "a failed build's card floats over the PDF, explaining the error on its quoted line",
            explained,
            json!({ "card": card.map(|(shown, docked, expanded, headline, marked)| json!({
                "shown": shown, "docked": docked, "expanded": expanded, "headline": headline, "marked": marked,
            })) }),
        );
        self.snapshot(cx, "diagnostics-card").await;

        // Nothing changed: an unattended build restates the failure.
        let before = self.builds(cx);
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.build_unattended(window, cx))
        })?;
        let built = self.built_after(cx, before).await;
        let replay = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            panel.outcome().map(|outcome| {
                (
                    outcome.unchanged,
                    outcome.succeeded,
                    outcome.counts.error,
                    outcome.steps.len(),
                )
            })
        });
        steps.check(
            "an unattended build of the unchanged failing document restates its errors without typesetting",
            built && replay.is_some_and(|(unchanged, succeeded, errors, passes)| {
                unchanged && !succeeded && errors > 0 && passes == 0
            }),
            json!({ "replay": replay }),
        );
        Ok(())
    }

    /// An explained typo's one-click fix, a missing package's install, the
    /// clean and the clean rebuild, and a stopped build.
    pub(super) async fn build_fixes(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        stub: &StubTexSetup,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let main = root.join("main.tex");
        let original_main = std::fs::read_to_string(&main)?;

        // A typo of \emph: the card offers it, and its fix builds clean.
        let text = std::fs::read_to_string(&chapter)?;
        std::fs::write(&chapter, format!("{text}\n\\emhp{{fixed}}\n"))?;
        // The fix lands in the editor, so the editor must hold the typo first.
        let open = self.open(cx, &chapter, None)?;
        self.wait_for(cx, Duration::from_secs(10), |_, cx| {
            open.read(cx).editor().read(cx).text(cx).contains("\\emhp")
        })
        .await;
        let before = self.builds(cx);
        self.build(cx).await.ok();
        let built = self.built_after(cx, before).await;
        let offered = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            let last = panel.last()?;
            last.explained.iter().position(|explained| {
                explained
                    .as_ref()
                    .is_some_and(|explained| explained.suggestion.as_deref() == Some("\\emph"))
            })
        });
        let mut fixed = false;
        if let Some(ix) = offered {
            let before = self.builds(cx);
            cx.update(|cx| {
                self.shell
                    .read(cx)
                    .build_panel()
                    .clone()
                    .update(cx, |panel, cx| panel.replace(ix, cx));
            });
            let rebuilt = self.built_after(cx, before).await;
            let saved = self
                .wait_for(cx, Duration::from_secs(8), |_, _| {
                    std::fs::read_to_string(&chapter)
                        .is_ok_and(|text| text.contains("\\emph{fixed}"))
                })
                .await;
            let succeeded = cx.update(|cx| self.shell.read(cx).build_panel().read(cx).succeeded());
            fixed = rebuilt && saved && succeeded == Some(true);
        }
        steps.check(
            "a typo's explanation offers the paper's command, and Replace saves and builds clean",
            built && offered.is_some() && fixed,
            json!({ "offered": offered, "fixed": fixed }),
        );

        // A package no distribution has: Install asks which of the packages
        // that provide it, "installs" the pick (the stand-in), and builds.
        let usepackage = format!("\\usepackage{{{MISSING_PACKAGE}}}\n\\begin{{document}}");
        self.rewrite_open_file(
            cx,
            &main,
            &original_main.replacen("\\begin{document}", &usepackage, 1),
        )
        .await?;
        let file = format!("{MISSING_PACKAGE}.sty");
        let offered = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            panel.last().is_some_and(|last| {
                last.diagnostics.iter().any(|diagnostic| {
                    diagnostics::install_target(diagnostic).as_deref() == Some(file.as_str())
                })
            })
        });
        cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().clone();
            panel.update(cx, |panel, cx| {
                panel.act(BuildAction::Install(file.clone()), cx)
            });
        });
        let center = cx.update(|cx| self.shell.read(cx).tex_setup().clone());
        let choices = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                center
                    .read(cx)
                    .dependency()
                    .is_some_and(|install| install.packages.is_some())
            })
            .await;
        self.snapshot(cx, "package-chooser").await;
        let before = self.builds(cx);
        cx.update(|cx| {
            center.update(cx, |center, cx| {
                center.install_dependency(file.clone(), Some("lattice-e2e-a".into()), cx)
            })
        });
        let rebuilt = self.built_after(cx, before).await;
        let installed = cx.update(|cx| {
            center.read(cx).dependency().is_none()
                && self.shell.read(cx).build_panel().read(cx).succeeded() == Some(true)
        });
        steps.check(
            "a missing package's Install offers its providers, installs the pick and builds (stand-in installer)",
            offered && choices && rebuilt && installed && root.join(&file).is_file(),
            json!({ "offered": offered, "choices": choices, "installed": installed, "calls": stub.calls() }),
        );
        std::fs::remove_file(root.join(&file)).ok();
        self.rewrite_open_file(cx, &main, &original_main).await?;

        // Clean deletes the auxiliary files; a clean rebuild writes them anew.
        // `latexmk -c` deletes main.aux before it exits, and a clean rebuild
        // asked for while the clean runs is turned away (`clean_rebuild`), so
        // wait for the clean itself to finish, not only for the file to go.
        // Clean also does nothing while a build runs, so a build the removed
        // .sty or the rewrite set off late settles first.
        let aux = root.join("main.aux");
        let started = std::time::Instant::now();
        let state = |shell: &gpui::Entity<crate::shell::Shell>, cx: &mut gpui::App| {
            let shell = shell.read(cx);
            json!({
                "ms": started.elapsed().as_millis() as u64,
                "building": shell.building(),
                "cleaning": shell.cleaning(),
                "builds": shell.build_panel().read(cx).builds(),
                "aux": aux.exists(),
            })
        };
        let settled = self
            .wait_for(cx, Duration::from_secs(180), |shell, cx| {
                let shell = shell.read(cx);
                !shell.building() && !shell.cleaning()
            })
            .await;
        let at_clean = cx.update(|cx| state(&self.shell, cx));
        // Whether the window's focus would have reached the shell
        // (`dispatch_to_shell`).
        let focus_in_shell = self.with_window(cx, |shell, window, cx| {
            shell.read(cx).focus_handle(cx).contains_focused(window, cx)
        })?;
        self.dispatch_to_shell(cx, &CleanBuildFiles)?;
        let cleaned = self
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                !aux.exists() && !shell.read(cx).cleaning()
            })
            .await;
        let at_rebuild = cx.update(|cx| state(&self.shell, cx));
        let before = self.builds(cx);
        self.dispatch_to_shell(cx, &CleanRebuild)?;
        let rebuilt = self.built_after(cx, before).await;
        let at_end = cx.update(|cx| state(&self.shell, cx));
        let clean_build = cx.update(|cx| self.shell.read(cx).build_panel().read(cx).succeeded());
        let rewritten = aux.exists();
        steps.check(
            "Clean deletes the build files, and a clean rebuild writes them again",
            cleaned && rebuilt && clean_build == Some(true) && rewritten,
            json!({
                "settled": settled,
                "focus_in_shell": focus_in_shell,
                "cleaned": cleaned,
                "rebuilt": rebuilt,
                "succeeded": clean_build,
                "aux_written": rewritten,
                "at_clean": at_clean,
                "at_rebuild": at_rebuild,
                "at_end": at_end,
            }),
        );

        // A document that loops: Stop ends the build, which reports nothing.
        // The outside edit builds it on its own (main.tex is open); only
        // when it does not is it built here, so no second build of the loop
        // starts after the stop (TeX would spin until the stall limit).
        let looping = "\\begin{document}\n\\def\\latticeloop{\\latticeloop}\\latticeloop";
        let before = self.builds(cx);
        std::fs::write(
            &main,
            original_main.replacen("\\begin{document}", looping, 1),
        )?;
        let running = |shell: &gpui::Entity<crate::shell::Shell>, cx: &mut gpui::App| {
            shell.read(cx).build_panel().read(cx).is_running()
        };
        let mut started = self.wait_for(cx, Duration::from_secs(8), running).await;
        if !started {
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| {
                    shell.build(&crate::shell::Build, window, cx)
                })
            })?;
            started = self.wait_for(cx, Duration::from_secs(20), running).await;
        }
        self.pause(cx, Duration::from_millis(1500)).await;
        self.dispatch_to_shell(cx, &StopBuild)?;
        let stopped = self.built_after(cx, before).await;
        let report = cx.update(|cx| {
            let panel = self.shell.read(cx).build_panel().read(cx);
            (
                panel.outcome().is_none(),
                panel.last().is_some_and(|last| {
                    last.diagnostics
                        .iter()
                        .any(|diagnostic| diagnostic.code == Some("build-cancelled"))
                }),
            )
        });
        steps.check(
            "Stop ends a build that loops, which then reports nothing but that it stopped",
            started && stopped && report == (true, true),
            json!({ "started": started, "stopped": stopped, "no_outcome": report.0, "cancelled": report.1 }),
        );
        self.rewrite_open_file(cx, &main, &original_main).await?;
        Ok(())
    }

    /// The TeX doctor's report, and the setup wizard's install when a check
    /// finds TeX missing (the stand-in's report and installer).
    pub(super) async fn doctor_and_setup(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        stub: &StubTexSetup,
    ) -> Result<()> {
        let center = cx.update(|cx| self.shell.read(cx).tex_setup().clone());
        self.dispatch_to_shell(cx, &OpenTexDoctor)?;
        let reported = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                let center = center.read(cx);
                center.doctor_open()
                    && !center.busy()
                    && center.report().is_some_and(|report| report.ok)
            })
            .await;
        // Its package check (the stand-in has lineno out of date).
        let found = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                let packages = center.read(cx).packages();
                !packages.checking && packages.offer()
            })
            .await;
        self.snapshot(cx, "tex-doctor").await;
        steps.check("the TeX doctor reports every check", reported, json!({}));
        cx.update(|cx| center.update(cx, |center, cx| center.update_packages(cx)));
        let updated = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                let packages = center.read(cx).packages();
                !packages.checking
                    && packages
                        .run
                        .as_ref()
                        .is_some_and(|run| !run.running && run.error.is_none())
                    && packages
                        .report
                        .as_ref()
                        .is_some_and(|report| report.packages.is_empty())
            })
            .await;
        cx.update(|cx| center.update(cx, |center, cx| center.close_doctor(cx)));
        steps.check(
            "the TeX doctor finds a package update, and its one-click update runs and rechecks (stand-in installer)",
            found && updated && stub.calls().iter().any(|call| call == "update_packages"),
            json!({ "found": found, "updated": updated }),
        );

        stub.set_reports(vec![
            StubTexSetup::report(&["latexmk"]),
            StubTexSetup::report(&[]),
        ]);
        self.dispatch_to_shell(cx, &InstallLatexTools)?;
        let opened = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                let center = center.read(cx);
                center.wizard_open() && !center.busy()
            })
            .await;
        self.snapshot(cx, "setup-wizard").await;
        cx.update(|cx| center.update(cx, |center, cx| center.start_install(cx)));
        let installed = self
            .wait_for(cx, Duration::from_secs(20), |_, cx| {
                !center.read(cx).wizard_open()
            })
            .await;
        let calls = stub.calls();
        steps.check(
            "a check that finds TeX missing opens setup, whose install verifies and closes it (stand-in installer)",
            opened && installed && calls.iter().any(|call| call.starts_with("install_tex")),
            json!({ "opened": opened, "installed": installed, "calls": calls }),
        );
        Ok(())
    }
}
