//! The e2e checks of Get started (`crate::get_started`): the palette's
//! "Show Get started panel" bringing the checklist up beside the documents
//! (not as a tab of their panel), the fixture (a project of the writer's
//! own) having marked the last step; Skip passing a step over; "Show me"
//! bringing the manuscript forward with the ring on it, and Escape taking
//! the ring down; a SyncTeX jump marking its step; then the tutorial opening with the
//! checklist shown, and the fixture's layout, opened again, leaving it out.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Keystroke, PlatformInput};
use serde_json::json;

use super::Steps;
use crate::{
    get_started::{
        Host, Step, TUTORIAL_VENUE,
        panel::{GetStartedEvent, Standing},
        progress, steps,
    },
    scenario::Run,
    shell::ForwardSync,
};

impl Run {
    pub(super) async fn get_started(
        &self,
        cx: &mut AsyncApp,
        steps_run: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        self.open(cx, &root.join("chapters/intro.tex"), Some(2))?;
        self.with_window(cx, |shell, window, cx| {
            window.focus(&shell.read(cx).focus_handle.clone(), cx);
            window.dispatch_action(Box::new(crate::shell::ShowGetStarted), cx)
        })?;
        let shown = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell.read(cx).view_on_screen("start", cx)
            })
            .await;
        let (start_panel, document_panel, own) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let start = shell.placement("start", cx).map(|(_, panel, _)| panel);
            let documents = shell.document_panel_of_layout(cx);
            let own = progress::global(cx).read(cx).is_done(Step::Own);
            (start, documents, own)
        });
        steps_run.check(
            "Show Get started panel brings the checklist up beside the documents, not as a tab of theirs",
            shown && start_panel.is_some() && start_panel != document_panel,
            json!({ "start": start_panel, "documents": document_panel }),
        );
        self.get_started_shot(cx, "get-started-panel").await;
        steps_run.check(
            "a project of the writer's own marks the checklist's last step",
            own,
            json!({}),
        );

        let host = Host::current();
        let before = cx.update(|cx| Standing::read(&steps(host), cx).current);
        cx.update(|cx| progress::skip(Step::Cite, cx));
        let after = cx.update(|cx| {
            let standing = Standing::read(&steps(host), cx);
            (standing.skipped.contains(&Step::Cite), standing.current)
        });
        steps_run.check(
            "Skip passes a step over, and the next undone one becomes current",
            after.0 && after.1 != Some(Step::Cite),
            json!({ "before": format!("{before:?}"), "after": format!("{:?}", after.1) }),
        );

        // "Show me" for the build: main.tex comes forward, at its title
        // where it has one, with the ring on it. (The build step is the
        // sample's, so it is never done in the fixture, and the ring draws.)
        let panel = cx.update(|cx| self.shell.read(cx).get_started.panel.clone());
        panel.update(cx, |_, cx| cx.emit(GetStartedEvent::ShowMe(Step::Build)));
        self.pause(cx, Duration::from_millis(300)).await;
        let (ringing, front) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let front = shell
                .active_editor()
                .map(|editor| editor.read(cx).path().to_path_buf());
            (shell.get_started.showing(), front)
        });
        steps_run.check(
            "Show me brings the manuscript forward and rings it",
            ringing == Some(Step::Build)
                && front.as_deref() == Some(root.join("main.tex").as_path()),
            json!({ "ringing": format!("{ringing:?}"), "front": front }),
        );
        self.get_started_shot(cx, "get-started-show-me-ring").await;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_event(
                PlatformInput::KeyDown(gpui::KeyDownEvent {
                    keystroke: Keystroke::parse("escape").expect("escape parses"),
                    is_held: false,
                    prefer_character_input: false,
                }),
                cx,
            );
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let after_escape = cx.update(|cx| self.shell.read(cx).get_started.showing());
        steps_run.check(
            "Escape takes the ring down",
            after_escape.is_none(),
            json!({ "ringing": format!("{after_escape:?}") }),
        );

        // Again, then a press in the manuscript: the ring hears it only
        // where it was drawn, so this is the check that it was.
        panel.update(cx, |_, cx| cx.emit(GetStartedEvent::ShowMe(Step::Build)));
        self.pause(cx, Duration::from_millis(300)).await;
        let at = cx.update(|cx| {
            let shell = self.shell.read(cx);
            let panel = shell.manuscript_panel(&shell.root(cx)?, cx)?;
            Some(shell.workspace().read(cx).panel_bounds(&panel)?.center())
        });
        if let Some(at) = at {
            self.with_window(cx, |_, window, cx| {
                for event in [
                    PlatformInput::MouseDown(gpui::MouseDownEvent {
                        button: gpui::MouseButton::Left,
                        position: at,
                        modifiers: gpui::Modifiers::default(),
                        click_count: 1,
                        first_mouse: false,
                    }),
                    PlatformInput::MouseUp(gpui::MouseUpEvent {
                        button: gpui::MouseButton::Left,
                        position: at,
                        modifiers: gpui::Modifiers::default(),
                        click_count: 1,
                    }),
                ] {
                    window.dispatch_event(event, cx);
                }
            })?;
        }
        self.pause(cx, Duration::from_millis(200)).await;
        let after_press = cx.update(|cx| self.shell.read(cx).get_started.showing());
        steps_run.check(
            "the ring is drawn over the manuscript, and a press anywhere takes it down",
            at.is_some() && after_press.is_none(),
            json!({ "at": at.map(|at| format!("{at:?}")), "ringing": format!("{after_press:?}") }),
        );

        // A jump from the source to the PDF is the step itself.
        self.open(cx, &root.join("chapters/intro.tex"), Some(2))?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(ForwardSync), cx)
        })?;
        let jumped = self
            .wait_for(cx, Duration::from_secs(10), |_, cx| {
                progress::global(cx).read(cx).is_done(Step::Jump)
            })
            .await;
        steps_run.check("a SyncTeX jump marks the jump step done", jumped, json!({}));

        // The tutorial, only in the scratch HOME the e2e script gives the
        // run (its Documents folder is where the sample is made).
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        let canonical = |path: &Path| path.canonicalize().unwrap_or(path.to_path_buf());
        let scratch = home
            .as_deref()
            .and_then(Path::parent)
            .is_some_and(|scratch| canonical(root).starts_with(canonical(scratch)));
        if !scratch {
            steps_run.check(
                "the tutorial checks need the e2e script's scratch HOME (skipped)",
                true,
                json!({ "home": home }),
            );
            return Ok(());
        }
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_tutorial(window, cx))
        })?;
        let tutorial = self
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                let shell = shell.read(cx);
                shell
                    .project()
                    .is_some_and(|project| project.read(cx).manifest().venue == TUTORIAL_VENUE)
                    && shell.view_on_screen("start", cx)
            })
            .await;
        steps_run.check(
            "opening the tutorial shows the checklist with the sample",
            tutorial,
            json!({}),
        );
        let fixture = root.to_path_buf();
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_project(fixture, window, cx))
        })?;
        let back = self
            .wait_for(cx, Duration::from_secs(30), |shell, cx| {
                shell.read(cx).root(cx).as_deref() == Some(root)
            })
            .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let start_kept = cx.update(|cx| self.shell.read(cx).placement("start", cx).is_some());
        steps_run.check(
            "the writer's own project, opened again, leaves the sample's checklist out",
            back && !start_kept,
            json!({ "back": back, "start_in_layout": start_kept }),
        );
        Ok(())
    }

    /// Save the window as `name`.png into `LATTICE_E2E_SHOTS`, when set.
    /// Drawn and read back at once, not through `capture`: that waits up to
    /// 8 s for two PDF pages, the fixture's PDF has one, and the Show me
    /// ring is gone after 8 s.
    async fn get_started_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(feature = "offscreen-shots")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            let out = Path::new(&dir).join(format!("{name}.png"));
            let shot = self.with_window(cx, |_, window, cx| {
                window.refresh();
                let _ = window.draw(cx);
                window.render_to_image()
            });
            match shot {
                Ok(Ok(image)) => {
                    if let Err(error) = image.save(&out) {
                        log::warn!("e2e shot {name}: {error:#}");
                    }
                }
                Ok(Err(error)) | Err(error) => log::warn!("e2e shot {name}: {error:#}"),
            }
        }
        #[cfg(not(feature = "offscreen-shots"))]
        let _ = (cx, name);
    }
}
