//! The Terminal scenario's screenshots for the look review
//! (`LATTICE_TERMINAL_SHOTS=DIR`): the window at each state, the panel as
//! a narrow tab in Simplified Chinese, and a prompt that names no account
//! or machine.

use std::time::Duration;

use anyhow::Result;
use gpui::AsyncApp;
#[cfg(target_os = "macos")]
use lattice_ui::ActiveLattice as _;

use super::super::super::Run;

impl Run {
    /// With `LATTICE_TERMINAL_SHOTS=DIR`, the window now as
    /// `DIR/terminal-<name>-<appearance>.png`, for the look review.
    pub(super) async fn terminal_shot(&self, cx: &mut AsyncApp, name: &str) -> Result<()> {
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
    pub(super) async fn narrow_chinese_shot(&self, cx: &mut AsyncApp) -> Result<()> {
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
    pub(super) async fn neutral_prompt_for_shots(&self, cx: &mut AsyncApp) {
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
}
