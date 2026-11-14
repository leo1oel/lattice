//! The e2e checks of inserting tables and figures (`crate::insert`,
//! `shell/insert_flow.rs`): the palette's Insert table opening the table
//! generator on a chapter, a 2 by 2 table reviewed and written as a managed
//! table on a line of its own, the caret back in it opening it again to
//! edit, an edit in the editor meanwhile refusing the write, a table edited
//! by hand left to the source editor; a project image inserted as a figure
//! through the Insert figure dialog; and ⌘V with an image in the editor
//! saving it into `figures/` and offering it as a figure. With
//! `LATTICE_E2E_SHOTS=DIR` (macOS, `offscreen-shots`) it saves the window at
//! the generator, its review, its refusal and unsupported messages, and the
//! Insert figure dialog.

use std::{path::Path, time::Duration};

use anyhow::{Context as _, Result};
use gpui::{AsyncApp, Entity};
use serde_json::json;

use super::Steps;
use crate::{
    editor_panel::EditorPanel, insert::table_dialog::TableGenerator, scenario::Run,
    shell::InsertTable,
};

const MARKER: &str = "% lattice-table-v1 ";

impl Run {
    pub(super) async fn insert_tools(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let chapter = root.join("chapters/intro.tex");
        let editor = self.open(cx, &chapter, Some(2))?;
        self.pause(cx, Duration::from_millis(300)).await;
        let original = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        self.tables(cx, steps, &editor).await?;
        self.figures(cx, steps, root, &editor).await?;
        // The chapter as it was, for the modules after.
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                let len = editor.text_and_caret(cx).0.len();
                editor.replace_range(0, len, &original, 0, window, cx)
            })
        })?;
        Ok(())
    }

    fn open_generator(&self, cx: &mut AsyncApp) -> Result<Option<Entity<TableGenerator>>> {
        self.with_window(cx, |shell, window, cx| {
            window.dispatch_action(Box::new(InsertTable), cx);
            let _ = shell;
        })?;
        Ok(cx.update(|cx| {
            self.shell
                .read(cx)
                .inserts
                .table
                .as_ref()
                .map(|open| open.sheet.clone())
        }))
    }

    async fn tables(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        editor: &Entity<EditorPanel>,
    ) -> Result<()> {
        // The caret mid line: the table goes on a line of its own.
        let (text, _) = cx.update(|cx| editor.read(cx).text_and_caret(cx));
        let mid = text
            .find("introduces")
            .context("the chapter's second line")?;
        self.with_window(cx, |_, window, cx| {
            editor.update(cx, |editor, cx| {
                editor.replace_range(mid, mid, "", mid, window, cx)
            })
        })?;
        self.pause(cx, Duration::from_millis(100)).await;
        let sheet = self.open_generator(cx)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let Some(sheet) = sheet.or(cx.update(|cx| {
            self.shell
                .read(cx)
                .inserts
                .table
                .as_ref()
                .map(|open| open.sheet.clone())
        })) else {
            steps.check("Insert table opens the table generator", false, json!({}));
            return Ok(());
        };
        let fresh = cx.update(|cx| {
            let sheet = sheet.read(cx);
            sheet.supported() && *sheet.data() == crate::insert::table::new_table()
        });
        steps.check(
            "Insert table opens the table generator on a new 3 by 3 table",
            fresh,
            json!({}),
        );
        self.insert_shot(cx, "insert-table-generator").await;
        self.with_window(cx, |_, window, cx| {
            sheet.update(cx, |sheet, cx| {
                sheet.resize(2, 2, window, cx);
                sheet.open_review(cx);
            })
        })?;
        self.insert_shot(cx, "insert-table-review").await;
        let reviewing = cx.update(|cx| sheet.read(cx).reviewing());
        sheet.update(cx, |sheet, cx| sheet.apply(cx));
        self.pause(cx, Duration::from_millis(200)).await;
        let (after, caret) = cx.update(|cx| editor.read(cx).text_and_caret(cx));
        let marker = after.find(MARKER);
        let closed = cx.update(|cx| self.shell.read(cx).inserts.table.is_none());
        steps.check(
            "Review source changes, then Insert table writes a managed 2 by 2 table on a line of its own, the caret at its \\begin",
            reviewing
                && closed
                && marker.is_some_and(|at| at > 0 && after.as_bytes()[at - 1] == b'\n')
                && after.contains("\\begin{tabular}{ll}")
                && after.contains("% /lattice-table\n")
                && after[caret..].starts_with("\\begin{table}"),
            json!({ "reviewing": reviewing, "closed": closed, "text": after }),
        );

        // The caret inside it opens it to edit, and the edit replaces it.
        let reopened = self.open_generator(cx)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let edit_ok = if let Some(sheet) = reopened {
            let found = cx.update(|cx| sheet.read(cx).data().align.len() == 2);
            self.with_window(cx, |_, window, cx| {
                sheet.update(cx, |sheet, cx| sheet.resize(3, 2, window, cx))
            })?;
            sheet.update(cx, |sheet, cx| sheet.apply(cx));
            self.pause(cx, Duration::from_millis(200)).await;
            let text = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
            found && text.matches(MARKER).count() == 1 && text.matches("\\\\\n").count() == 3
        } else {
            false
        };
        steps.check(
            "the caret in the table opens it again to edit, and the edit replaces it",
            edit_ok,
            json!({}),
        );

        // An edit made while the generator is open: the write is refused.
        let sheet = self.open_generator(cx)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let refused = if let Some(sheet) = sheet {
            // Applied from the review, as the writer applies it.
            sheet.update(cx, |sheet, cx| sheet.open_review(cx));
            self.with_window(cx, |_, window, cx| {
                editor.update(cx, |editor, cx| {
                    editor.replace_range(0, 0, "% typed\n", 0, window, cx)
                })
            })?;
            sheet.update(cx, |sheet, cx| sheet.apply(cx));
            self.insert_shot(cx, "insert-table-refused").await;
            let error = cx.update(|cx| sheet.read(cx).error().map(str::to_string));
            let still_open = cx.update(|cx| self.shell.read(cx).inserts.table.is_some());
            sheet.update(cx, |_, cx| {
                cx.emit(crate::insert::table_dialog::TableEvent::Close)
            });
            error.is_some() && still_open
        } else {
            false
        };
        steps.check(
            "an edit made while the generator is open refuses its write and says why",
            refused,
            json!({}),
        );

        // A managed table edited by hand is the source editor's.
        let (text, _) = cx.update(|cx| editor.read(cx).text_and_caret(cx));
        if let Some(at) = text.find("\\toprule") {
            self.with_window(cx, |_, window, cx| {
                editor.update(cx, |editor, cx| {
                    editor.replace_range(at, at + "\\toprule".len(), "\\hline", at, window, cx)
                })
            })?;
        }
        let sheet = self.open_generator(cx)?;
        self.pause(cx, Duration::from_millis(200)).await;
        let unsupported = sheet
            .as_ref()
            .is_some_and(|sheet| cx.update(|cx| !sheet.read(cx).supported()));
        self.insert_shot(cx, "insert-table-unsupported").await;
        if let Some(sheet) = sheet {
            sheet.update(cx, |_, cx| {
                cx.emit(crate::insert::table_dialog::TableEvent::Close)
            });
        }
        steps.check(
            "a table edited by hand is left to the source editor",
            unsupported,
            json!({}),
        );
        Ok(())
    }

    async fn figures(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
        editor: &Entity<EditorPanel>,
    ) -> Result<()> {
        let mut png = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(4, 3, image::Rgba([40, 120, 200, 255]))
            .write_to(&mut png, image::ImageFormat::Png)?;
        let png = png.into_inner();
        std::fs::create_dir_all(root.join("figures"))?;
        std::fs::write(root.join("figures/e2e-plot.png"), &png)?;
        self.with_window(cx, |shell, window, cx| {
            shell.update(cx, |shell, cx| {
                shell.insert_figures(vec!["figures/e2e-plot.png".into()], window, cx)
            })
        })?;
        let shown = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell.read(cx).inserts.figure.is_some()
            })
            .await;
        let dialog = cx.update(|cx| {
            self.shell
                .read(cx)
                .inserts
                .figure
                .as_ref()
                .map(|open| open.dialog.clone())
        });
        self.insert_shot(cx, "insert-figure-dialog").await;
        if let Some(dialog) = &dialog {
            dialog.update(cx, |dialog, cx| dialog.insert(cx));
        }
        self.pause(cx, Duration::from_millis(200)).await;
        let text = cx.update(|cx| editor.read(cx).text_and_caret(cx).0);
        steps.check(
            "a project image goes in as a figure through the Insert figure dialog",
            shown
                && text.contains(
                    "\\includegraphics[width=\\linewidth]{\\detokenize{figures/e2e-plot.png}}",
                )
                && text.contains("\\label{fig:e2e-plot}"),
            json!({ "shown": shown }),
        );

        // ⌘V with an image in the editor: saved into figures/, offered as a figure.
        let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, png.clone());
        cx.update(|cx| cx.write_to_clipboard(gpui::ClipboardItem::new_image(&image)));
        self.with_window(cx, |_, window, cx| {
            let focus = gpui::Focusable::focus_handle(editor.read(cx).editor().read(cx), cx);
            window.focus(&focus, cx);
            window.dispatch_action(Box::new(editor::actions::Paste), cx);
        })?;
        let offered = self
            .wait_for(cx, Duration::from_secs(8), |shell, cx| {
                shell.read(cx).inserts.figure.as_ref().is_some_and(|open| {
                    open.dialog.read(cx).paths().iter().any(|path| {
                        path.starts_with("figures/clipboard-") && path.ends_with(".png")
                    })
                })
            })
            .await;
        let pasted: Vec<_> = std::fs::read_dir(root.join("figures"))?
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.to_string_lossy().contains("clipboard-"))
            .collect();
        let same = pasted
            .first()
            .and_then(|path| std::fs::read(path).ok())
            .is_some_and(|bytes| bytes == png);
        self.insert_shot(cx, "insert-figure-pasted").await;
        steps.check(
            "⌘V with an image in the editor saves it into figures/ and offers it as a figure",
            offered && same,
            json!({ "files": pasted }),
        );
        let dialog = cx.update(|cx| {
            self.shell
                .read(cx)
                .inserts
                .figure
                .as_ref()
                .map(|open| open.dialog.clone())
        });
        if let Some(dialog) = dialog {
            dialog.update(cx, |_, cx| {
                cx.emit(crate::insert::figure_dialog::FigureDialogEvent::Close)
            });
        }
        for file in pasted {
            std::fs::remove_file(file).ok();
        }
        std::fs::remove_file(root.join("figures/e2e-plot.png")).ok();
        Ok(())
    }

    /// Save the window as `name`.png into `LATTICE_E2E_SHOTS`, when set,
    /// drawn and read back at once as `get_started.rs` does.
    async fn insert_shot(&self, cx: &mut AsyncApp, name: &str) {
        #[cfg(feature = "offscreen-shots")]
        if let Some(dir) = std::env::var_os("LATTICE_E2E_SHOTS") {
            self.pause(cx, Duration::from_millis(300)).await;
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
