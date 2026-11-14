//! The Terminal panel, end to end (`src/terminal/`): ⌃` opens it across the
//! foot of the workspace with the writer's login shell in the project
//! folder, naming Lattice as its terminal; native keys type into the shell;
//! a program's colours are the design system's; ⌘F finds in the scrollback;
//! a second terminal brings the tab strip, a tab renames in place; ⌘W on a
//! terminal running a command asks first; hiding the panel keeps the shells;
//! a shell that fails says how it ended, the last one exiting cleanly closes
//! the panel, and closing the panel ends its shells.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _};
use lattice_ui::ActiveLattice as _;
use serde_json::{Value, json};
use terminal::{Color, NamedColor};

use super::{super::Run, Steps};
use crate::terminal::{NewTerminal, SessionState, ToggleTerminalPanel};

impl Run {
    /// The Terminal panel's checks alone, for work on the terminal: the
    /// e2e scenario runs them too.
    pub(in crate::scenario) async fn terminal(&self, cx: &mut AsyncApp) -> Result<Value> {
        let mut steps = Steps::new(self);
        let root = self.root(cx).await?;
        self.pause(cx, Duration::from_millis(800)).await;
        self.terminal_panel(cx, &mut steps, &root).await?;
        steps.check_foreground(self);
        let passed = steps.0.iter().all(|step| step["passed"] == true);
        Ok(json!({ "scenario": "terminal", "passed": passed, "steps": steps.0 }))
    }

    pub(super) async fn terminal_panel(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let bound = self.with_window(cx, |_, window, cx| {
            let os = cx.platform_info().os;
            window
                .bindings_for_action(&ToggleTerminalPanel)
                .iter()
                .any(|binding| {
                    binding
                        .keystrokes()
                        .iter()
                        .map(|keystroke| keystroke.unparse(os))
                        .collect::<Vec<_>>()
                        == ["ctrl-`"]
                })
        })?;
        self.dispatch(cx, ToggleTerminalPanel)?;
        let running = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let panel = shell.read(cx).terminal().read(cx);
                panel.sessions().len() == 1
                    && panel.sessions()[0].state == SessionState::Running
                    && panel.sessions()[0].screen.is_some()
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        let (placed, bounds) = self.terminal_placement(cx)?;
        let focused = self.with_window(cx, |shell, window, cx| {
            shell
                .read(cx)
                .terminal()
                .read(cx)
                .focus_handle(cx)
                .contains_focused(window, cx)
        })?;
        let shell_name = cx.update(|cx| {
            self.shell
                .read(cx)
                .terminal()
                .read(cx)
                .sessions()
                .first()
                .map(|session| session.shell.clone())
        });
        let login = lattice_core::terminal::shell_launch().name();
        steps.check(
            "⌃` opens the Terminal across the foot of the workspace, running the login shell, focused",
            bound && running && placed && focused && shell_name.as_deref() == Some(login.as_str()),
            json!({ "bound": bound, "running": running, "placed": placed, "bounds": bounds, "focused": focused, "shell": shell_name }),
        );

        // A HOME with no zsh startup files (a scratch HOME, a fresh runner)
        // starts zsh's new-user menu; its "0" writes a one-line .zshrc, as a
        // writer would answer it.
        self.wait_for(cx, Duration::from_secs(3), |shell, cx| {
            !terminal_text(shell, cx).trim().is_empty()
        })
        .await;
        if self.terminal_content(cx).contains("zsh-newuser-install") {
            self.type_text(cx, "0").await?;
            self.pause(cx, Duration::from_millis(500)).await;
        }

        self.neutral_prompt_for_shots(cx).await;

        // Native keys reach the shell, which runs in the project folder.
        self.type_text(cx, "pwd\n").await?;
        let canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let in_root = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                let text = terminal_text(shell, cx);
                text.contains(&*root.to_string_lossy())
                    || text.contains(&*canonical.to_string_lossy())
            })
            .await;
        steps.check(
            "typing runs a command in the shell, in the project folder",
            in_root,
            json!({ "root": root, "tail": tail(&self.terminal_content(cx)) }),
        );

        self.type_text(cx, "printenv\n").await?;
        let named = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                terminal_text(shell, cx).contains("TERM_PROGRAM=Lattice")
            })
            .await;
        let text = self.terminal_content(cx);
        let home = std::env::var("HOME").unwrap_or_default();
        steps.check(
            "the shell names Lattice as its terminal, and none of Zed's variables",
            named
                && text.contains("TERM=xterm-256color")
                && text.contains("COLORTERM=truecolor")
                && !text.contains("ZED_TERM=")
                && text.contains(&format!("HOME={home}")),
            json!({ "named": named, "zed": text.contains("ZED_TERM=") }),
        );

        if std::env::var_os("LATTICE_TERMINAL_SHOTS").is_some() {
            self.clear_terminal(cx);
        }
        // A program's red is the design system's danger colour.
        cx.update(|cx| {
            if let Some(terminal) = self.active_terminal(cx) {
                terminal.update(cx, |terminal, _| terminal.input(ansi_sample().into_bytes()));
            }
        });
        let red = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                let panel = shell.read(cx).terminal().read(cx);
                panel
                    .sessions()
                    .iter()
                    .filter_map(|session| session.screen.as_ref())
                    .any(|screen| {
                        let terminal = screen.read(cx).terminal().read(cx);
                        terminal.last_content.cells.iter().any(|cell| {
                            cell.character() == 'l'
                                && cell.foreground() == Color::Named(NamedColor::Red)
                        })
                    })
            })
            .await;
        let (ansi_red, danger, palette) = cx.update(|cx| {
            let lattice = cx.lattice();
            let colors = lattice_ui::editor_theme::terminal::TerminalColors::new(
                lattice.code_theme,
                &lattice.palette,
            );
            let hex = |color: gpui::Hsla| {
                let rgba = gpui::Rgba::from(color);
                format!(
                    "#{:02x}{:02x}{:02x}",
                    (rgba.r * 255.).round() as u8,
                    (rgba.g * 255.).round() as u8,
                    (rgba.b * 255.).round() as u8
                )
            };
            let glyph = |kind| hex(lattice.palette.glyph(kind).0);
            // What the colours were made from, and what they came to, for
            // comparing with the Tauri app's CSS (terminal.css).
            let palette = json!({
                "inputs": {
                    "ground": hex(colors.ground), "ink": hex(colors.ink),
                    "danger": hex(lattice.palette.danger), "success": hex(lattice.palette.success),
                    "warning": hex(lattice.palette.warning),
                    "glyph_tex": glyph(lattice_ui::GlyphKind::Tex),
                    "glyph_style": glyph(lattice_ui::GlyphKind::Style),
                    "glyph_board": glyph(lattice_ui::GlyphKind::Board),
                },
                "kind": format!("{:?}", colors.kind),
                "ansi": colors.ansi.iter().map(|color| hex(*color)).collect::<Vec<_>>(),
            });
            (colors.ansi[1], lattice.palette.danger, palette)
        });
        self.terminal_shot(cx, "output").await?;
        steps.check(
            "a program's colours draw in the design system's: ANSI red is the danger colour",
            red && ansi_red == danger,
            json!({ "drawn": red, "palette": palette }),
        );

        // ⌘F finds in the scrollback; Escape closes the field.
        self.type_text(cx, "echo latticeok\n").await?;
        self.wait_for(cx, Duration::from_secs(8), |shell, cx| {
            terminal_text(shell, cx).matches("latticeok").count() >= 2
        })
        .await;
        self.press(cx, 'f', true).await?;
        let opened = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                shell.read(cx).terminal().read(cx).find_state().is_some()
            })
            .await;
        self.type_text(cx, "latticeok").await?;
        let found = self
            .wait_for(cx, Duration::from_secs(4), |shell, cx| {
                shell
                    .read(cx)
                    .terminal()
                    .read(cx)
                    .find_state()
                    .is_some_and(|(current, count)| count >= 2 && current.is_some())
            })
            .await;
        let state = cx.update(|cx| self.shell.read(cx).terminal().read(cx).find_state());
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let (closed, refocused) = self.with_window(cx, |shell, window, cx| {
            let panel = shell.read(cx).terminal().read(cx);
            (
                panel.find_state().is_none(),
                panel
                    .active_screen_focus(cx)
                    .is_some_and(|focus| focus.is_focused(window)),
            )
        })?;
        steps.check(
            "⌘F finds in the scrollback, counting the matches; Escape closes it and the keyboard returns",
            opened && found && closed && refocused,
            json!({ "opened": opened, "state": state, "closed": closed, "refocused": refocused }),
        );

        // A second terminal brings the tab strip; a tab renames in place.
        self.dispatch(cx, NewTerminal)?;
        let two = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let panel = shell.read(cx).terminal().read(cx);
                panel.sessions().len() == 2
                    && panel.sessions()[1].state == SessionState::Running
                    && panel.active_key() == Some(panel.sessions()[1].key)
            })
            .await;
        let labels = self.terminal_labels(cx);
        let second = cx.update(|cx| self.shell.read(cx).terminal().read(cx).sessions()[1].key);
        self.with_window(cx, |shell, window, cx| {
            shell
                .read(cx)
                .terminal()
                .clone()
                .update(cx, |panel, cx| panel.start_rename(second, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(100)).await;
        self.type_text(cx, "latex build\n").await?;
        self.pause(cx, Duration::from_millis(150)).await;
        let renamed = self.terminal_labels(cx);
        // The tab in front takes the keyboard; ← and → move along the strip.
        let keys = self.with_window(cx, |shell, window, cx| {
            let panel = shell.read(cx).terminal().clone();
            let Some(focus) = panel.read(cx).active_tab_focus() else {
                return (None, None);
            };
            focus.focus(window, cx);
            let key = |name: &'static str| gpui::Keystroke::parse(name).expect("a key");
            window.dispatch_keystroke(key("left"), cx);
            let left = panel.read(cx).active_key();
            window.dispatch_keystroke(key("right"), cx);
            (left, panel.read(cx).active_key())
        })?;
        let keyboard = keys
            == (cx.update(|cx| {
                let panel = self.shell.read(cx).terminal().read(cx);
                (Some(panel.sessions()[0].key), Some(panel.sessions()[1].key))
            }));
        if std::env::var_os("LATTICE_TERMINAL_SHOTS").is_some() {
            self.neutral_prompt_for_shots(cx).await;
            self.focus_active_terminal(cx)?;
            self.type_text(cx, "ls\n").await?;
            self.press(cx, 'f', true).await?;
            self.type_text(cx, "tex").await?;
            self.pause(cx, Duration::from_millis(400)).await;
            self.terminal_shot(cx, "tabs-find").await?;
            self.press(cx, '\u{1b}', false).await?;
            self.narrow_chinese_shot(cx).await?;
        }
        steps.check(
            "New terminal opens a second tab in front; a tab renames in place, and ← → move along the tabs",
            two && labels == ["Terminal 1", "Terminal 2"]
                && renamed == ["Terminal 1", "latex build"]
                && keyboard,
            json!({ "labels": labels, "renamed": renamed, "arrows": keys }),
        );

        // ⌘W on a terminal running a command asks first.
        self.focus_active_terminal(cx)?;
        self.type_text(cx, "cat\n").await?;
        let busy = self
            .wait_for(cx, Duration::from_secs(5), |shell, cx| {
                shell
                    .read(cx)
                    .terminal()
                    .read(cx)
                    .running(None, cx)
                    .iter()
                    .any(|name| name == "cat")
            })
            .await;
        self.press(cx, 'w', true).await?;
        self.pause(cx, Duration::from_millis(200)).await;
        let question = cx.update(|cx| self.shell.read(cx).confirm().read(cx).question());
        let asked = question.as_deref() == Some("Close the terminal?");
        let kept = cx.update(|cx| self.shell.read(cx).terminal().read(cx).sessions().len()) == 2;
        self.with_window(cx, |shell, window, cx| {
            shell
                .read(cx)
                .confirm()
                .clone()
                .update(cx, |confirm, cx| confirm.accept(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let left = self.terminal_labels(cx);
        steps.check(
            "⌘W on a terminal running a command asks before closing it, then closes only that tab",
            busy && asked && kept && left == ["Terminal 1"],
            json!({ "busy": busy, "question": question, "left": left }),
        );

        // Switching the window to another project ends its shells, so with
        // a command running it asks first; Escape keeps the project.
        self.focus_active_terminal(cx)?;
        self.type_text(cx, "cat\n").await?;
        self.wait_for(cx, Duration::from_secs(5), |shell, cx| {
            !shell
                .read(cx)
                .terminal()
                .read(cx)
                .running(None, cx)
                .is_empty()
        })
        .await;
        let elsewhere = root.with_file_name("another-project");
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_project(elsewhere, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (question, name) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            (shell.confirm().read(cx).question(), shell.project_name(cx))
        });
        let switch_asked = question.as_deref() == Some(&*format!("Switch away from “{name}”?"));
        self.press(cx, '\u{1b}', false).await?;
        self.pause(cx, Duration::from_millis(300)).await;
        let stayed = cx.update(|cx| {
            let shell = self.shell.read(cx);
            shell.confirm().read(cx).question().is_none()
                && shell.root(cx).as_deref() == Some(root)
                && shell.terminal().read(cx).sessions().len() == 1
        });
        // ⌃D ends `cat`.
        cx.update(|cx| {
            if let Some(terminal) = self.active_terminal(cx) {
                terminal.update(cx, |terminal, _| terminal.input(vec![4u8]));
            }
        });
        self.wait_for(cx, Duration::from_secs(5), |shell, cx| {
            shell
                .read(cx)
                .terminal()
                .read(cx)
                .running(None, cx)
                .is_empty()
        })
        .await;
        steps.check(
            "switching to another project with a command running asks first; Escape stays",
            switch_asked && stayed,
            json!({ "question": question, "stayed": stayed }),
        );

        // Hiding the panel keeps its shells and their scrollback.
        self.dispatch(cx, ToggleTerminalPanel)?;
        let hidden = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                !shell.read(cx).view_on_screen("terminal", cx)
            })
            .await;
        let kept = cx.update(|cx| self.shell.read(cx).terminal().read(cx).sessions().len());
        self.dispatch(cx, ToggleTerminalPanel)?;
        let shown = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                shell.read(cx).view_on_screen("terminal", cx)
            })
            .await;
        let scrollback = self.terminal_content(cx).contains("latticeok");
        let placement = cx.update(|cx| {
            self.shell
                .read(cx)
                .placement("terminal", cx)
                .map(|(placement, panel, visible)| format!("{placement:?} {panel} {visible}"))
        });
        steps.check(
            "⌃` hides the panel and brings it back with its shell and scrollback",
            hidden && kept == 1 && shown && scrollback,
            json!({ "hidden": hidden, "kept": kept, "shown": shown, "scrollback": scrollback, "placement": placement }),
        );

        // A shell that fails keeps its tab and says how it ended; closed by
        // hand, the panel waits with New terminal.
        self.focus_active_terminal(cx)?;
        self.type_text(cx, "exit 3\n").await?;
        let ended = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell
                    .read(cx)
                    .terminal()
                    .read(cx)
                    .sessions()
                    .first()
                    .is_some_and(|session| session.state == SessionState::Exited(Some(3)))
            })
            .await;
        self.terminal_shot(cx, "exited").await?;
        self.with_window(cx, |shell, window, cx| {
            shell.read(cx).terminal().clone().update(cx, |panel, cx| {
                if let Some(key) = panel.active_key() {
                    panel.close(key, window, cx);
                }
            })
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        self.terminal_shot(cx, "empty").await?;
        let waiting = self.view_shown(cx, "terminal")
            && cx.update(|cx| {
                self.shell
                    .read(cx)
                    .terminal()
                    .read(cx)
                    .sessions()
                    .is_empty()
            });
        steps.check(
            "a shell exiting with an error keeps its tab, saying so; its last tab closed, the panel waits",
            ended && waiting,
            json!({ "ended": ended, "waiting": waiting }),
        );

        // The last shell exiting cleanly closes the panel; ⌃` brings it
        // back with a fresh terminal.
        self.dispatch(cx, NewTerminal)?;
        self.wait_for(cx, Duration::from_secs(15), |shell, cx| {
            shell
                .read(cx)
                .terminal()
                .read(cx)
                .sessions()
                .first()
                .is_some_and(|session| session.state == SessionState::Running)
        })
        .await;
        self.focus_active_terminal(cx)?;
        self.type_text(cx, "exit\n").await?;
        let closed = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                !shell.read(cx).document(cx).views.contains_key("terminal")
            })
            .await;
        self.dispatch(cx, ToggleTerminalPanel)?;
        let fresh = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let panel = shell.read(cx).terminal().read(cx);
                panel.sessions().len() == 1 && panel.sessions()[0].state == SessionState::Running
            })
            .await;
        steps.check(
            "exit closes the last tab and the panel with it; ⌃` brings a fresh terminal",
            closed && fresh,
            json!({ "closed": closed, "fresh": fresh }),
        );

        self.terminal_keyboard(cx, steps, root).await?;

        // Closing the panel ends its shells.
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                shell.close_with_terminal(vec!["terminal".into()], cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let gone = cx.update(|cx| {
            let shell = self.shell.read(cx);
            !shell.document(cx).views.contains_key("terminal")
                && shell.terminal().read(cx).sessions().is_empty()
        });
        steps.check("closing the panel ends its shells", gone, json!({}));
        Ok(())
    }

    /// With `LATTICE_TERMINAL_SHOTS=DIR`, the window now as
    /// `DIR/terminal-<name>-<appearance>.png`, for the look review.
    async fn terminal_shot(&self, cx: &mut AsyncApp, name: &str) -> Result<()> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (cx, name);
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            self.macos_terminal_shot(cx, name).await
        }
    }

    #[cfg(target_os = "macos")]
    async fn macos_terminal_shot(&self, cx: &mut AsyncApp, name: &str) -> Result<()> {
        let Some(dir) = std::env::var_os("LATTICE_TERMINAL_SHOTS") else {
            return Ok(());
        };
        self.park_pointer(cx)?;
        self.pause(cx, Duration::from_millis(700)).await;
        let appearance = cx.update(|cx| match cx.lattice().palette.appearance {
            lattice_ui::Appearance::Light => "light",
            lattice_ui::Appearance::Dark => "dark",
        });
        let out = std::path::Path::new(&dir).join(format!("terminal-{name}-{appearance}.png"));
        self.capture(cx, &out.to_string_lossy()).await
    }

    /// The panel as a tab of Project's narrow panel, in Simplified Chinese,
    /// with its find field open; then back across the foot, in English.
    async fn narrow_chinese_shot(&self, cx: &mut AsyncApp) -> Result<()> {
        use lattice_settings::InterfaceLanguage;
        use trellis::model::{DockTarget, Edge};
        cx.update(|cx| {
            crate::settings::update_appearance(cx, |a| {
                a.interface_language = InterfaceLanguage::ZhCn
            })
        });
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                if let Some(into) = shell.panel_holding("project", cx) {
                    shell.engine_do(cx, |engine| {
                        engine.dock("terminal", Some(DockTarget::Into { into, index: None }));
                        engine.focus("terminal");
                    });
                }
            })
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        self.focus_active_terminal(cx)?;
        self.press(cx, 'f', true).await?;
        self.type_text(cx, "tex").await?;
        self.terminal_shot(cx, "narrow-zh").await?;
        self.press(cx, '\u{1b}', false).await?;
        cx.update(|cx| {
            crate::settings::update_appearance(cx, |a| a.interface_language = InterfaceLanguage::En)
        });
        self.with_window(cx, |shell, _, cx| {
            shell.update(cx, |shell, cx| {
                let root = shell
                    .document(cx)
                    .root
                    .as_ref()
                    .map(|root| root.id().to_string());
                if let Some(beside) = root {
                    shell.engine_do(cx, |engine| {
                        engine.dock(
                            "terminal",
                            Some(DockTarget::Beside {
                                beside,
                                edge: Edge::Bottom,
                                share: Some(crate::terminal::TERMINAL_SHARE),
                            }),
                        );
                        engine.focus("terminal");
                    });
                }
            })
        })?;
        self.pause(cx, Duration::from_millis(500)).await;
        Ok(())
    }

    /// For the look review's shots only: a prompt that names no account or
    /// machine, and none of the shell's greeting.
    async fn neutral_prompt_for_shots(&self, cx: &mut AsyncApp) {
        if std::env::var_os("LATTICE_TERMINAL_SHOTS").is_none() {
            return;
        }
        let command = match lattice_core::terminal::shell_launch().name().as_str() {
            "fish" => "function fish_prompt; echo -n 'project> '; end\n",
            "bash" | "sh" => "PS1='project> '\n",
            _ => "PROMPT='project> '\n",
        };
        cx.update(|cx| {
            if let Some(terminal) = self.active_terminal(cx) {
                terminal.update(cx, |terminal, _| {
                    terminal.input(command.as_bytes().to_vec())
                });
            }
        });
        self.pause(cx, Duration::from_millis(500)).await;
        self.clear_terminal(cx);
        self.pause(cx, Duration::from_millis(200)).await;
    }

    fn clear_terminal(&self, cx: &mut AsyncApp) {
        cx.update(|cx| {
            if let Some(terminal) = self.active_terminal(cx) {
                terminal.update(cx, |terminal, _| terminal.clear());
            }
        });
    }

    fn dispatch(&self, cx: &mut AsyncApp, action: impl gpui::Action) -> Result<()> {
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_action(Box::new(action), cx)
        })
    }

    fn view_shown(&self, cx: &mut AsyncApp, view: &str) -> bool {
        cx.update(|cx| self.shell.read(cx).view_on_screen(view, cx))
    }

    pub(super) fn active_terminal(
        &self,
        cx: &gpui::App,
    ) -> Option<gpui::Entity<terminal::Terminal>> {
        let panel = self.shell.read(cx).terminal().read(cx);
        let key = panel.active_key()?;
        let session = panel.sessions().iter().find(|session| session.key == key)?;
        Some(session.screen.as_ref()?.read(cx).terminal().clone())
    }

    fn terminal_content(&self, cx: &mut AsyncApp) -> String {
        cx.update(|cx| terminal_text(&self.shell, cx))
    }

    fn terminal_labels(&self, cx: &mut AsyncApp) -> Vec<String> {
        cx.update(|cx| {
            self.shell
                .read(cx)
                .terminal()
                .read(cx)
                .sessions()
                .iter()
                .map(|session| session.label())
                .collect()
        })
    }

    fn focus_active_terminal(&self, cx: &mut AsyncApp) -> Result<()> {
        self.with_window(cx, |shell, window, cx| {
            if let Some(focus) = shell.read(cx).terminal().read(cx).active_screen_focus(cx) {
                focus.focus(window, cx);
            }
        })
    }

    /// The panel spans the whole workspace's width, under every other panel.
    fn terminal_placement(&self, cx: &mut AsyncApp) -> Result<(bool, serde_json::Value)> {
        Ok(cx.update(|cx| {
            let shell = self.shell.read(cx);
            let workspace = shell.workspace().read(cx);
            let doc = shell.document(cx);
            let Some(own) = shell.panel_holding("terminal", cx) else {
                return (false, json!(null));
            };
            let Some(bounds) = workspace.panel_bounds(&own) else {
                return (false, json!(null));
            };
            let others: Vec<_> = crate::shell::trellis_layout::panels_of(&doc, false)
                .into_iter()
                .filter(|panel| panel.id != own)
                .filter_map(|panel| workspace.panel_bounds(&panel.id))
                .collect();
            let left = others
                .iter()
                .map(|b| f32::from(b.left()))
                .fold(f32::MAX, f32::min);
            let right = others
                .iter()
                .map(|b| f32::from(b.right()))
                .fold(f32::MIN, f32::max);
            let above = others
                .iter()
                .all(|b| f32::from(b.bottom()) <= f32::from(bounds.top()) + 1.);
            let placed = !others.is_empty()
                && above
                && f32::from(bounds.left()) <= left + 1.
                && f32::from(bounds.right()) >= right - 1.;
            (
                placed,
                json!({
                    "x": f32::from(bounds.left()), "y": f32::from(bounds.top()),
                    "w": f32::from(bounds.size.width), "h": f32::from(bounds.size.height),
                }),
            )
        }))
    }
}

fn terminal_text(shell: &gpui::Entity<crate::shell::Shell>, cx: &gpui::App) -> String {
    let panel = shell.read(cx).terminal().read(cx);
    panel
        .sessions()
        .iter()
        .filter(|session| Some(session.key) == panel.active_key())
        .filter_map(|session| session.screen.as_ref())
        .map(|screen| screen.read(cx).terminal().read(cx).get_content())
        .collect()
}

/// A command that prints a line in ANSI red (the check's) and the sixteen
/// colours, normal then bright, each on its own and as a background.
fn ansi_sample() -> String {
    let names = [
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    ];
    let mut line = String::from("printf '\\033[31mlatticered\\033[0m\\n");
    for (bright, base) in [(false, 30), (true, 90)] {
        for (index, name) in names.iter().enumerate() {
            let name = if bright {
                format!("b{name}")
            } else {
                name.to_string()
            };
            line.push_str(&format!("\\033[{}m{name}\\033[0m ", base + index));
        }
        line.push_str("\\n");
    }
    line.push_str("\\033[1mbold\\033[0m \\033[2mfaint\\033[0m \\033[3mitalic\\033[0m \\033[4munderline\\033[0m \\033[7minverse\\033[0m\\n'\n");
    line
}

/// The last lines of `text`, for a failed step's detail.
fn tail(text: &str) -> String {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(6)..].join("\n")
}
