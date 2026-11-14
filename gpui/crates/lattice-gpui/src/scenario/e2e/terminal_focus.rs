//! Where the keyboard goes as the Terminal panel comes and goes
//! (`terminal-slot.tsx`: a screen takes the keyboard only while its panel
//! has it): hiding the panel with the keyboard in it hands the keyboard to
//! the document in front, so the window's commands (⌃` among them) still
//! reach the shell; a terminal that starts or closes on its own while the
//! writer types elsewhere leaves the keyboard where it is.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, Focusable as _};
use serde_json::json;

use super::{super::Run, Steps};
use crate::{
    editor_panel::EditorPanel,
    terminal::{NewTerminal, SessionState, ToggleTerminalPanel},
};

impl Run {
    /// Run with the panel on screen and a shell running in it.
    pub(super) async fn terminal_keyboard(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let editor = self.open(cx, &root.join("main.tex"), None)?;

        // Hidden with the keyboard in it.
        self.with_window(cx, |shell, window, cx| {
            if let Some(focus) = shell.read(cx).terminal().read(cx).active_screen_focus(cx) {
                focus.focus(window, cx);
            }
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(ToggleTerminalPanel), cx)
        })?;
        let hidden = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                !shell.read(cx).view_on_screen("terminal", cx)
            })
            .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let (in_document, in_terminal) = self.keyboard(cx, &editor)?;
        steps.check(
            "⌃` hiding the Terminal with the keyboard in it hands the keyboard to the document",
            hidden && in_document && !in_terminal,
            json!({ "hidden": hidden, "in_document": in_document, "in_terminal": in_terminal }),
        );

        // Brought on screen without being asked for the keyboard (a layout
        // restored, a project switched to), with no shell yet: the shell it
        // starts leaves the keyboard in the document.
        self.with_window(cx, |shell, window, cx| {
            shell.read(cx).terminal().clone().update(cx, |panel, cx| {
                let keys: Vec<usize> = panel.sessions().iter().map(|s| s.key).collect();
                for key in keys {
                    panel.close(key, window, cx);
                }
            });
            window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.show_view("terminal", false, window, cx)
            })
        })?;
        let started = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let panel = shell.read(cx).terminal().read(cx);
                panel.sessions().len() == 1
                    && panel.sessions()[0].state == SessionState::Running
                    && panel.sessions()[0].screen.is_some()
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;
        let (in_document, in_terminal) = self.keyboard(cx, &editor)?;
        steps.check(
            "a terminal starting in a panel brought on screen by itself leaves the keyboard in the document",
            started && in_document && !in_terminal,
            json!({ "started": started, "in_document": in_document, "in_terminal": in_terminal }),
        );

        // A shell in front exiting cleanly while the writer types elsewhere.
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(NewTerminal), cx)
        })?;
        let two = self
            .wait_for(cx, Duration::from_secs(15), |shell, cx| {
                let sessions = shell.read(cx).terminal().read(cx).sessions();
                sessions.len() == 2
                    && sessions
                        .iter()
                        .all(|session| session.state == SessionState::Running)
            })
            .await;
        self.pause(cx, Duration::from_millis(400)).await;

        // A tab being renamed when the writer moves to the document: the
        // name is kept and the keyboard stays where the writer put it. In a
        // foreground section (`input_lock.rs`), since an inactive window
        // reports no blur; on a locked screen nothing becomes active, so the
        // scenario emits the field's blur, as GPUI would in a key window.
        // With Vim's keymap loaded, whose bindings for a keyboard outside any
        // editor begin with Space (`space f`), so the name keeps its space
        // only if those stay out of a text field.
        let front = self.foreground(cx, "terminal_rename_blur").await?;
        cx.update(|cx| crate::app::set_vim_mode(true, cx));
        self.with_window(cx, |shell, window, cx| {
            shell.read(cx).terminal().clone().update(cx, |panel, cx| {
                if let Some(key) = panel.active_key() {
                    panel.start_rename(key, window, cx);
                }
            });
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        self.type_text(cx, "left field").await?;
        let field = cx.update(|cx| self.shell.read(cx).terminal().read(cx).rename_input());
        self.with_window(cx, |_, window, cx| {
            window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
        })?;
        self.pause(cx, Duration::from_millis(100)).await;
        let active = self.with_window(cx, |_, window, _| window.is_window_active())?;
        if !active && let Some(field) = field {
            field.update(cx, |_, cx| {
                cx.emit(gpui_kit::component::input::InputEvent::Blur)
            });
        }
        self.pause(cx, Duration::from_millis(200)).await;
        let labels: Vec<String> = cx.update(|cx| {
            let panel = self.shell.read(cx).terminal().read(cx);
            panel
                .sessions()
                .iter()
                .map(|session| session.label())
                .collect()
        });
        let (in_document, in_terminal) = self.keyboard(cx, &editor)?;
        drop(front);
        cx.update(|cx| crate::app::set_vim_mode(false, cx));
        steps.check(
            "leaving a tab's rename field for the document keeps the name and leaves the keyboard there",
            two && labels.iter().any(|label| label == "left field") && in_document && !in_terminal,
            json!({ "active": active, "labels": labels, "in_document": in_document, "in_terminal": in_terminal }),
        );

        // Vim turned off again: Space on the tab in front selects it at once,
        // not held as the start of one of Vim's bindings (`space f`).
        let (pending, selected) = self.with_window(cx, |shell, window, cx| {
            let panel = shell.read(cx).terminal().clone();
            let (Some(focus), Some(key)) = (
                panel.read(cx).active_tab_focus(),
                panel.read(cx).active_key(),
            ) else {
                return (None, false);
            };
            focus.focus(window, cx);
            window.dispatch_keystroke(gpui::Keystroke::parse("space").expect("a key"), cx);
            let pending = window.has_pending_keystrokes();
            window.focus(&editor.read(cx).editor().focus_handle(cx), cx);
            (Some(pending), panel.read(cx).active_key() == Some(key))
        })?;
        steps.check(
            "with Vim turned off, Space on a terminal tab is not held for one of Vim's keys",
            pending == Some(false) && selected,
            json!({ "pending": pending, "selected": selected }),
        );

        cx.update(|cx| {
            if let Some(terminal) = self.active_terminal(cx) {
                terminal.update(cx, |terminal, _| terminal.input(b"exit\n".to_vec()));
            }
        });
        let exited = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell.read(cx).terminal().read(cx).sessions().len() == 1
            })
            .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let (in_document, in_terminal) = self.keyboard(cx, &editor)?;
        steps.check(
            "a terminal exiting cleanly while the writer types in the document leaves the keyboard there",
            two && exited && in_document && !in_terminal,
            json!({ "two": two, "exited": exited, "in_document": in_document, "in_terminal": in_terminal }),
        );

        // The shell left in front asks for a blinking caret (DECSCUSR 1, as
        // vi-mode prompts send) while the keyboard is in the document: an
        // unfocused caret is drawn still, so it never leaves its shown phase.
        cx.update(|cx| {
            if let Some(terminal) = self.active_terminal(cx) {
                terminal.update(cx, |terminal, _| {
                    terminal.input(b"printf '\\033[1 q'\n".to_vec())
                });
            }
        });
        self.pause(cx, Duration::from_millis(300)).await;
        let mut phases = Vec::new();
        for _ in 0..8 {
            phases.push(cx.update(|cx| {
                let panel = self.shell.read(cx).terminal().read(cx);
                let key = panel.active_key()?;
                let session = panel.sessions().iter().find(|session| session.key == key)?;
                Some(session.screen.as_ref()?.read(cx).caret_shown())
            }));
            self.pause(cx, Duration::from_millis(200)).await;
        }
        let (in_document, _) = self.keyboard(cx, &editor)?;
        steps.check(
            "an unfocused terminal asked for a blinking caret keeps it still",
            in_document && phases.iter().all(|phase| *phase == Some(true)),
            json!({ "in_document": in_document, "phases": phases }),
        );

        // Hidden with the keyboard in its find field, beside the screen.
        self.with_window(cx, |shell, window, cx| {
            shell
                .read(cx)
                .terminal()
                .clone()
                .update(cx, |panel, cx| panel.open_find(window, cx));
        })?;
        self.pause(cx, Duration::from_millis(150)).await;
        let in_find = self.with_window(cx, |shell, window, cx| {
            let panel = shell.read(cx).terminal().read(cx);
            panel.find_state().is_some()
                && panel.holds_focus(window, cx)
                && !panel
                    .active_screen_focus(cx)
                    .is_some_and(|screen| screen.contains_focused(window, cx))
        })?;
        self.with_window(cx, |_, window, cx| {
            window.dispatch_action(Box::new(ToggleTerminalPanel), cx)
        })?;
        let hidden = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                !shell.read(cx).view_on_screen("terminal", cx)
            })
            .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let (in_document, in_terminal) = self.keyboard(cx, &editor)?;
        steps.check(
            "⌃` hiding the Terminal with the keyboard in its find field hands the keyboard to the document",
            in_find && hidden && in_document && !in_terminal,
            json!({ "in_find": in_find, "hidden": hidden, "in_document": in_document, "in_terminal": in_terminal }),
        );
        Ok(())
    }

    /// Whether the keyboard is in `editor`, and whether it is in the
    /// Terminal panel.
    fn keyboard(&self, cx: &mut AsyncApp, editor: &Entity<EditorPanel>) -> Result<(bool, bool)> {
        let editor = editor.clone();
        self.with_window(cx, move |shell, window, cx| {
            (
                editor
                    .read(cx)
                    .editor()
                    .focus_handle(cx)
                    .contains_focused(window, cx),
                shell.read(cx).terminal().read(cx).holds_focus(window, cx),
            )
        })
    }
}
