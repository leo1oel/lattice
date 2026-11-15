//! The e2e checks of the shortcut sheet and of Escape in focus mode, as the
//! Tauri app has them (`shortcut-sheet.tsx`, `shortcut-groups.ts`,
//! `use-focus-mode-escape.ts`): the sheet lists the command table's keys by
//! section with the palette's two keys as alternatives and the workspace
//! switch by place (a range once there are three), then Panels and tabs, Text editing, LaTeX and Visual
//! Markdown, and Leave focus mode on Escape; its field filters by name or by
//! key and says when nothing matches. In focus mode Escape in the document
//! first collapses a selection, then leaves focus mode; with the palette
//! open it closes the palette and focus mode stays. Focus mode's bar centres the
//! title on the window and ends with a Markdown file's Edit, Split and
//! Preview, the PDF toggle and Exit focus (`focus-mode-bar.tsx`), each doing
//! what it says. With the PDF beside the document, Escape in the PDF with text
//! selected only clears the selection, and the next one leaves focus mode.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Focusable as _, Keystroke};
use serde_json::{Value, json};

use super::Steps;
use crate::scenario::Run;

impl Run {
    async fn shortcut_sheet_checks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let file = root.join("focus-escape-check.tex");
        std::fs::write(&file, "\\section{Escape}\nFocus mode text.\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;

        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.open_shortcuts(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        let groups = self.sheet_groups(cx);
        let titles: Vec<&str> = groups
            .iter()
            .filter_map(|group| group["title"].as_str())
            .collect();
        let keys = |label: &str| -> Option<Value> {
            groups.iter().find_map(|group| {
                group["rows"]
                    .as_array()?
                    .iter()
                    .find(|row| row["label"] == label)
                    .cloned()
            })
        };
        let palette = keys("Command palette");
        let workspaces = keys("Switch to a workspace by its place");
        let leave = keys("Leave focus mode");
        let undo = keys("Undo");
        let bold = keys("Bold (\\textbf)");
        let heading = keys("Heading 1 to 6");
        let tabs = keys("Previous or next tab");
        steps.check(
            "the shortcut sheet lists the table's keys and the workspace's, editor's, LaTeX's and visual Markdown's",
            ["Panels and tabs", "Text editing", "LaTeX", "Visual Markdown"]
                .iter()
                .all(|title| titles.contains(title))
                && palette.as_ref().is_some_and(|row| row["combos"] == json!(["⌘K", "⇧⌘P"]))
                // One key per workspace the window has (the fixture's one),
                // a range from three.
                && workspaces.as_ref().is_some_and(|row| {
                    row["combos"][0] == "⌘1"
                        && (row["range"] == true) == (row["combos"].as_array().map_or(0, Vec::len) > 2)
                })
                && leave.as_ref().is_some_and(|row| row["combos"] == json!(["⎋"]))
                && undo.as_ref().is_some_and(|row| row["combos"] == json!(["⌘Z"]))
                && bold.as_ref().is_some_and(|row| row["combos"] == json!(["⌘B"]))
                && heading
                    .as_ref()
                    .is_some_and(|row| row["range"] == true && row["combos"][0] == "⌥⌘1")
                && tabs
                    .as_ref()
                    .is_some_and(|row| row["combos"] == json!(["⇧⌘[", "⇧⌘]"])),
            json!({ "titles": titles, "palette": palette, "workspaces": workspaces, "leave": leave, "undo": undo, "bold": bold, "heading": heading, "tabs": tabs }),
        );

        self.sheet_type(cx, "⇧⌘J")?;
        let by_key = self.sheet_groups(cx);
        self.sheet_type(cx, "no such shortcut")?;
        let none = self.sheet_groups(cx);
        steps.check(
            "the sheet's field filters by key, and finds nothing for a query nothing matches",
            by_key.len() == 1
                && by_key[0]["rows"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().all(|row| row["combos"][0] == "⇧⌘J"))
                && none.is_empty(),
            json!({ "by_key": by_key, "none": none }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.close_overlays(window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;

        // Focus mode, with the keyboard in the document and its text selected.
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_mode(true, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        let focus_editor = |window: &mut gpui::Window, cx: &mut gpui::App| {
            let inner = editor.read(cx).editor().clone();
            window.focus(&inner.focus_handle(cx), cx);
            inner.update(cx, |editor, cx| {
                editor.select_all(&editor::actions::SelectAll, window, cx)
            });
        };
        self.with_window(cx, |_, window, cx| focus_editor(window, cx))?;
        self.pause(cx, Duration::from_millis(100)).await;
        self.press_key(cx, "escape")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let after_selection = cx.update(|cx| self.shell.read(cx).in_focus_mode());
        self.press_key(cx, "escape")?;
        let left = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                !shell.read(cx).in_focus_mode()
            })
            .await;
        steps.check(
            "in focus mode Escape first collapses the selection, then leaves focus mode",
            after_selection && left,
            json!({ "after_selection": after_selection, "left": left }),
        );

        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.set_focus_mode(true, window, cx);
                shell.open_palette(window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(300)).await;
        self.press_key(cx, "escape")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (palette_open, still) = cx.update(|cx| {
            let shell = self.shell.read(cx);
            (shell.palette_view().is_some(), shell.in_focus_mode())
        });
        steps.check(
            "with the palette open Escape closes it, and focus mode stays",
            !palette_open && still,
            json!({ "palette_open": palette_open, "focus_mode": still }),
        );
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_mode(false, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(200)).await;
        self.close_tab(cx, editor)?;
        std::fs::remove_file(&file).ok();
        self.focus_bar_checks(cx, steps, root).await?;
        self.pdf_escape_checks(cx, steps).await
    }

    /// Focus mode's bar over a Markdown file: its title centred on the
    /// window, the file's Edit, Split and Preview, the PDF toggle and Exit
    /// focus, each doing what it says.
    async fn focus_bar_checks(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        lattice_ui::parity::enable();
        let file = root.join("focus-bar-check.md");
        std::fs::write(&file, "# Focus\n\nA note.\n")?;
        let editor = self.open(cx, &file, Some(1))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let pdf_before =
            cx.update(|cx| crate::shell::workspaces::Workspaces::global(cx).focus_pdf());
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_mode(true, window, cx))
        })?;
        lattice_ui::parity::forget("focus-bar/");
        self.pause(cx, Duration::from_millis(400)).await;
        let regions = lattice_ui::parity::regions();
        let bounds = |name: &str| regions.get(name).and_then(|region| region.bounds);
        let (title, views, pdf, exit) = (
            bounds("focus-bar/title"),
            bounds("focus-bar/views"),
            bounds("focus-bar/pdf"),
            bounds("focus-bar/exit"),
        );
        let width = self.with_window(cx, |_, window, _| f32::from(window.viewport_size().width))?;
        let centred =
            title.is_some_and(|title| (f32::from(title.center().x) - width / 2.).abs() <= 2.);
        let ordered = match (views, pdf, exit) {
            (Some(views), Some(pdf), Some(exit)) => {
                views.right() <= pdf.left() && pdf.right() <= exit.left()
            }
            _ => false,
        };
        steps.check(
            "focus mode's bar centres the title on the window and ends with Edit, Split and Preview, the PDF and Exit focus",
            centred && ordered,
            json!({ "title": format!("{title:?}"), "views": format!("{views:?}"), "pdf": format!("{pdf:?}"), "exit": format!("{exit:?}"), "width": width }),
        );

        if let Some(pdf) = pdf {
            self.click_at(cx, pdf.center())?;
        }
        let toggled = self
            .wait_for(cx, Duration::from_secs(2), |_, cx| {
                crate::shell::workspaces::Workspaces::global(cx).focus_pdf() != pdf_before
            })
            .await;
        lattice_ui::parity::forget("focus-bar/");
        self.pause(cx, Duration::from_millis(300)).await;
        let exit = lattice_ui::parity::regions()
            .get("focus-bar/exit")
            .and_then(|region| region.bounds);
        if let Some(exit) = exit {
            self.click_at(cx, exit.center())?;
        }
        let left = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                !shell.read(cx).in_focus_mode()
            })
            .await;
        steps.check(
            "the bar's PDF toggle shows or hides the PDF, and Exit focus leaves focus mode",
            toggled && left,
            json!({ "toggled": toggled, "left": left }),
        );
        // The PDF choice is every project's: put it back.
        if toggled {
            cx.update(|cx| {
                crate::shell::workspaces::Workspaces::update(cx, |library| {
                    library.set_focus_pdf(pdf_before)
                })
            });
        }
        self.close_tab(cx, editor)?;
        std::fs::remove_file(&file).ok();
        Ok(())
    }

    /// In focus mode with the PDF beside the document, Escape in the PDF
    /// with text selected only clears the selection; the next Escape
    /// leaves focus mode.
    async fn pdf_escape_checks(&self, cx: &mut AsyncApp, steps: &mut Steps) -> Result<()> {
        let pdf_before =
            cx.update(|cx| crate::shell::workspaces::Workspaces::global(cx).focus_pdf());
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| shell.set_focus_pdf(true, window, cx))
        })?;
        self.pause(cx, Duration::from_millis(400)).await;
        let view = cx.update(|cx| self.shell.read(cx).pdf().read(cx).live_view().clone());
        self.with_window(cx, {
            let view = view.clone();
            move |_, window, cx| {
                window.focus(&view.focus_handle(cx), cx);
                #[cfg(target_os = "macos")]
                view.update(cx, |view, cx| view.select((0, 0), (0, 8), cx));
            }
        })?;
        self.pause(cx, Duration::from_millis(100)).await;
        let selected = cx.update(|cx| view.read(cx).has_selection());
        self.press_key(cx, "escape")?;
        self.pause(cx, Duration::from_millis(200)).await;
        let (cleared, stayed) = cx.update(|cx| {
            (
                !view.read(cx).has_selection(),
                self.shell.read(cx).in_focus_mode(),
            )
        });
        self.press_key(cx, "escape")?;
        let left = self
            .wait_for(cx, Duration::from_secs(2), |shell, cx| {
                !shell.read(cx).in_focus_mode()
            })
            .await;
        steps.check(
            "in focus mode Escape in the PDF first clears its selection, then leaves focus mode",
            selected && cleared && stayed && left,
            json!({ "selected": selected, "cleared": cleared, "stayed": stayed, "left": left }),
        );
        cx.update(|cx| {
            crate::shell::workspaces::Workspaces::update(cx, |library| {
                library.set_focus_pdf(pdf_before)
            })
        });
        if !left {
            self.with_window(cx, |shell, window, cx| {
                shell.update(cx, |shell, cx| shell.set_focus_mode(false, window, cx))
            })?;
        }
        Ok(())
    }

    /// A press and release at `at`, as the window would get them.
    fn click_at(&self, cx: &mut AsyncApp, at: gpui::Point<gpui::Pixels>) -> Result<()> {
        self.with_window(cx, |_, window, cx| {
            for event in [
                gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                    button: gpui::MouseButton::Left,
                    position: at,
                    modifiers: gpui::Modifiers::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                    button: gpui::MouseButton::Left,
                    position: at,
                    modifiers: gpui::Modifiers::default(),
                    click_count: 1,
                }),
            ] {
                window.dispatch_event(event, cx);
            }
        })
    }

    /// The groups the sheet shows, as JSON for the step's evidence.
    fn sheet_groups(&self, cx: &mut AsyncApp) -> Vec<Value> {
        cx.update(|cx| {
            let Some(sheet) = self.shell.read(cx).shortcuts_view() else {
                return Vec::new();
            };
            sheet
                .read(cx)
                .shown()
                .iter()
                .map(|group| {
                    json!({
                        "title": group.title.to_string(),
                        "rows": group.rows.iter().map(|row| json!({
                            "label": row.label.to_string(),
                            "combos": row.combos.iter().map(|keys| keys.to_string()).collect::<Vec<_>>(),
                            "range": row.range,
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect()
        })
    }

    fn sheet_type(&self, cx: &mut AsyncApp, query: &str) -> Result<()> {
        let query = query.to_string();
        self.with_window(cx, move |shell, window, cx| {
            if let Some(sheet) = shell.read(cx).shortcuts_view() {
                sheet.update(cx, |sheet, cx| sheet.type_query(&query, window, cx));
            }
        })
    }

    /// A key pressed where the keyboard is, as the window dispatches it.
    fn press_key(&self, cx: &mut AsyncApp, keys: &'static str) -> Result<()> {
        let keystroke = Keystroke::parse(keys).map_err(|error| anyhow::anyhow!("{error}"))?;
        self.with_window(cx, move |_, window, cx| {
            window.dispatch_keystroke(keystroke, cx);
        })
    }
}

pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Terminal,
    rank: 98,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/shell/shortcut_sheet.rs",
        "gpui/crates/lattice-gpui/src/shell/shortcut_groups.rs",
        "gpui/crates/lattice-gpui/src/shell/focus_escape.rs",
        "gpui/crates/lattice-gpui/src/shell/commands/key_labels.rs",
        "gpui/crates/lattice-gpui/src/titlebar/focus_bar.rs",
        "gpui/crates/lattice-gpui/src/pdf/view/pointer.rs",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.shortcut_sheet_checks(cx, steps, &fixture.root)),
};
