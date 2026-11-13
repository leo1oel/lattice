//! Split's scroll following (`editor_panel/markdown_view.rs`,
//! `gpui/islands/markdown/split-scroll.ts`), on a long Markdown file of
//! numbered parts: the source scrolled far down brings the visual editor to
//! the same part, and the visual editor scrolled back up brings the source
//! with it.

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, point};
use serde_json::json;

use super::{Run, Steps};
use crate::editor_panel::{DocumentView, EditorPanel};

/// The part (`## Part N`) the source's centre line is in.
fn source_part(text: &str, center_line: usize) -> Option<u64> {
    text.lines()
        .take(center_line + 1)
        .filter_map(|line| line.strip_prefix("## Part "))
        .filter_map(|number| number.trim().parse().ok())
        .last()
}

/// The part whose heading is the last one above the visual editor's centre.
const PREVIEW_PART: &str = "JSON.stringify((() => { const viewport = document.querySelector('.editor-doc-scroll'); \
    const middle = viewport.getBoundingClientRect().top + viewport.clientHeight / 2; let part = null; \
    for (const heading of document.querySelectorAll('.lx-md-surface h2')) { \
    if (heading.getBoundingClientRect().top <= middle) part = Number(heading.textContent.replace('Part ', '')); else break; } \
    return { part, scrollTop: viewport.scrollTop }; })())";

impl Run {
    pub(super) async fn markdown_split_scroll(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        let mut text = String::from("# Long notes\n\n");
        for part in 1..=80 {
            text.push_str(&format!(
                "## Part {part}\n\nThis paragraph belongs to part {part}. It is long enough to wrap over two lines \
                 of the source at the editor's width, so the source's lines and the preview's blocks differ in height.\n\n"
            ));
        }
        let path = root.join("e2e-long.md");
        std::fs::write(&path, &text)?;
        let panel = self.open(cx, &path, None)?;
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                panel.update(cx, |panel, cx| {
                    panel.set_document_view(DocumentView::Split, window, cx)
                })
            }
        })?;
        let drawn = self
            .wait_for(cx, Duration::from_secs(40), |_, cx| {
                panel
                    .read(cx)
                    .markdown_document()
                    .is_some_and(|document| document.read(cx).is_drawn())
            })
            .await;
        let island = cx.update(|cx| {
            panel
                .read(cx)
                .markdown_document()
                .and_then(|document| document.read(cx).island().cloned())
        });
        let Some(island) = island.filter(|_| drawn) else {
            steps.check(
                "in Split the visual editor follows the source's scroll, and the source the visual editor's",
                false,
                json!({ "drawn": drawn }),
            );
            return Ok(());
        };
        self.pause(cx, Duration::from_millis(800)).await;

        // The source scrolled far down: the preview follows to its part.
        self.scroll_source(cx, &panel, 260.)?;
        self.pause(cx, Duration::from_millis(700)).await;
        let source_down = self.source_center_part(cx, &panel, &text);
        let preview_down = self.evaluate(cx, &island, PREVIEW_PART).await;
        let followed = matches!(
            (source_down, preview_down["part"].as_u64()),
            (Some(source), Some(preview)) if source.abs_diff(preview) <= 1
        );

        // The preview scrolled back up: the source follows to its part.
        self.evaluate(
            cx,
            &island,
            "(() => { const viewport = document.querySelector('.editor-doc-scroll'); viewport.scrollTop = viewport.scrollTop / 3; return null; })()",
        )
        .await;
        self.pause(cx, Duration::from_millis(900)).await;
        let preview_up = self.evaluate(cx, &island, PREVIEW_PART).await;
        let source_up = self.source_center_part(cx, &panel, &text);
        let led = matches!(
            (source_up, preview_up["part"].as_u64()),
            (Some(source), Some(preview)) if source.abs_diff(preview) <= 1
        ) && source_up < source_down;
        steps.check(
            "in Split the visual editor follows the source's scroll, and the source the visual editor's",
            followed && led,
            json!({
                "source_down": source_down, "preview_down": preview_down,
                "preview_up": preview_up, "source_up": source_up,
            }),
        );
        self.close_panel(cx, &panel).await?;
        Ok(())
    }

    fn scroll_source(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        top: f64,
    ) -> Result<()> {
        self.with_window(cx, {
            let panel = panel.clone();
            move |_, window, cx| {
                let editor = panel.read(cx).editor().clone();
                editor.update(cx, |editor, cx| {
                    editor.set_scroll_position(point(0., top), window, cx)
                });
            }
        })
    }

    /// The part the source's centre line is in.
    fn source_center_part(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
        text: &str,
    ) -> Option<u64> {
        let line = cx.update(|cx| {
            let editor = panel.read(cx).editor().clone();
            editor.update(cx, |editor, cx| {
                let half = editor.visible_line_count().unwrap_or(0.) / 2.;
                let row = (editor.scroll_position(cx).y + half).max(0.).floor() as u32;
                let snapshot = editor.display_snapshot(cx);
                editor::display_map::DisplayPoint::new(editor::display_map::DisplayRow(row), 0)
                    .to_point(&snapshot)
                    .row as usize
            })
        });
        source_part(text, line)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_source_part_is_the_last_heading_above_the_line() {
        let text = "# T\n\n## Part 1\n\na\n\n## Part 2\n\nb\n";
        assert_eq!(super::source_part(text, 0), None);
        assert_eq!(super::source_part(text, 4), Some(1));
        assert_eq!(super::source_part(text, 6), Some(2));
        assert_eq!(super::source_part(text, 99), Some(2));
    }
}
