//! A Markdown table's column widths (`table-column-widths.ts` in the engine,
//! `editor_panel/table_widths.rs` keeping them), driven with native
//! mouse events on the visual editor of a scratch file with two tables:
//!
//! - the pointer resting on a column's border shows the resize cursor;
//! - a drag of the first table's first border widens that column by the
//!   distance dragged, the file's bytes as they were, and the widths are
//!   kept for the file's table 0;
//! - a double-click on the second table's first border fits that column to
//!   its content (its long header), kept as table 1's;
//! - the tab closed and the file opened again draws both tables at the
//!   widths kept;
//! - a column added to the first table on disk drops its widths, and only
//!   its: the second keeps its own.

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity, Pixels, Point};
use lattice_webview::Island;
use serde_json::{Value, json};

use super::{Run, Steps};
use crate::{editor_panel::{EditorPanel, table_widths}, native};

const FILE: &str = "e2e-tables.md";

const TABLES: &str = "# Tables

| Model | Score |
| --- | --- |
| Base | 1 |

Between the tables.

| A fairly long header for fitting | B | C |
| --- | --- | --- |
| x | y | z |
";

/// The same file with a third column in its first table.
const WIDER: &str = "# Tables

| Model | Score | Extra |
| --- | --- | --- |
| Base | 1 | 2 |

Between the tables.

| A fairly long header for fitting | B | C |
| --- | --- | --- |
| x | y | z |
";

/// How far the border is dragged, in the page's pixels.
const DRAG: f64 = 80.;

/// The page's view of a table: its first header cell's right edge (brought
/// into view first), and its columns' set widths.
fn table_facts(index: usize) -> String {
    format!(
        "(() => {{ const table = document.querySelectorAll('.lx-md-surface table')[{index}]; if (!table) return null; \
         const cell = table.querySelector('th'); cell.scrollIntoView({{ block: 'center' }}); const r = cell.getBoundingClientRect(); \
         return JSON.stringify({{ edge: [r.right - 1, r.top + r.height / 2], width: cell.offsetWidth, \
           cols: [...table.querySelectorAll('col')].map((col) => col.style.width), sized: table.hasAttribute('data-sized'), \
           cursor: document.querySelector('.lx-md-editor')?.hasAttribute('data-column-resize') ?? false }}); }})()"
    )
}

fn px_widths(facts: &Value) -> Vec<f64> {
    facts["cols"]
        .as_array()
        .map(|cols| {
            cols.iter()
                .filter_map(|col| col.as_str()?.strip_suffix("px")?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

impl Run {
    pub(super) async fn markdown_table_widths(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        root: &Path,
    ) -> Result<()> {
        // A native press on the page makes its window key: the module's
        // pointer work runs in one foreground section.
        let _front = self.foreground(cx, "table column widths").await?;
        let path = root.join(FILE);
        std::fs::write(&path, TABLES)?;
        let panel = self.open(cx, &path, None)?;
        let Some(island) = self.table_island(cx, &panel).await else {
            steps.check(
                "a Markdown table's column border dragged resizes the column",
                false,
                json!({ "drawn": false }),
            );
            return Ok(());
        };
        let native = self.native(cx)?;
        let to_window = |bounds: gpui::Bounds<Pixels>, xy: &Value| -> Option<Point<Pixels>> {
            let x = xy.get(0)?.as_f64()?;
            let y = xy.get(1)?.as_f64()?;
            Some(bounds.origin + gpui::point(gpui::px(x as f32), gpui::px(y as f32)))
        };
        let bounds = cx.update(|cx| island.read(cx).bounds(cx));

        // Hover, then drag the first table's first border.
        let before = self.evaluate(cx, &island, &table_facts(0)).await;
        let edge = bounds.and_then(|bounds| to_window(bounds, &before["edge"]));
        let mut hover = Value::Null;
        if let Some(edge) = edge {
            native::send_mouse(native, native::Mouse::Moved, edge - gpui::point(gpui::px(20.), gpui::px(0.)))?;
            self.pause(cx, Duration::from_millis(80)).await;
            native::send_mouse(native, native::Mouse::Moved, edge)?;
            self.pause(cx, Duration::from_millis(150)).await;
            hover = self.evaluate(cx, &island, &table_facts(0)).await;
            // A mouse-moved event sent to the window does not reach the
            // page's view (WebKit hears moves through its tracking areas),
            // so the page is also given the move at the same point.
            if hover["cursor"] != true {
                let [x, y] = [&before["edge"][0], &before["edge"][1]].map(|v| v.as_f64().unwrap_or_default());
                hover = self
                    .evaluate(
                        cx,
                        &island,
                        &format!(
                            "(() => {{ const target = document.elementFromPoint({x}, {y}); \
                             target?.dispatchEvent(new MouseEvent('mousemove', {{ bubbles: true, clientX: {x}, clientY: {y} }})); \
                             return {}; }})()",
                            table_facts(0)
                        ),
                    )
                    .await;
            }
            native::send_mouse(native, native::Mouse::Down, edge)?;
            for step in 1..=8 {
                let dx = DRAG as f32 * step as f32 / 8.;
                native::send_mouse(native, native::Mouse::Dragged, edge + gpui::point(gpui::px(dx), gpui::px(0.)))?;
                self.pause(cx, Duration::from_millis(30)).await;
            }
            native::send_mouse(native, native::Mouse::Up, edge + gpui::point(gpui::px(DRAG as f32), gpui::px(0.)))?;
        }
        steps.check(
            "the pointer resting on a Markdown table's column border shows the resize cursor",
            hover["cursor"] == true,
            json!({ "edge": format!("{edge:?}"), "hover": hover }),
        );
        let kept = |cx: &mut AsyncApp| cx.update(|_| table_widths::page_widths(root, FILE));
        self.wait_for(cx, Duration::from_secs(3), |_, _| {
            table_widths::page_widths(root, FILE).get("0").is_some()
        })
        .await;
        let after = self.evaluate(cx, &island, &table_facts(0)).await;
        let widths = px_widths(&after);
        let expected = before["width"].as_f64().unwrap_or_default() + DRAG;
        let saved = kept(cx);
        let unchanged = std::fs::read_to_string(&path).is_ok_and(|text| text == TABLES);
        steps.check(
            "a Markdown table's column border dragged widens the column by the distance dragged; the widths are kept for the file's table 0 and the file's bytes stay as they were",
            after["sized"] == true
                && widths.first().is_some_and(|width| (width - expected).abs() <= 2.)
                && saved["0"].as_array().map(|kept| kept.len()) == Some(2)
                && saved["0"][0].as_f64().zip(widths.first()).is_some_and(|(kept, shown)| (kept - shown).abs() < 0.5)
                && unchanged,
            json!({ "before": before, "after": after, "expected": expected, "saved": saved, "unchanged": unchanged }),
        );

        // Double-click the second table's first border: the column fits its long header.
        let second = self.evaluate(cx, &island, &table_facts(1)).await;
        let bounds = cx.update(|cx| island.read(cx).bounds(cx));
        if let Some(edge) = bounds.and_then(|bounds| to_window(bounds, &second["edge"])) {
            native::send_mouse(native, native::Mouse::Moved, edge)?;
            self.pause(cx, Duration::from_millis(100)).await;
            native::send_double_click(native, edge)?;
        }
        self.wait_for(cx, Duration::from_secs(3), |_, _| {
            table_widths::page_widths(root, FILE).get("1").is_some()
        })
        .await;
        let fitted = self.evaluate(cx, &island, &table_facts(1)).await;
        let fitted_widths = px_widths(&fitted);
        let saved = kept(cx);
        steps.check(
            "a double-click on a Markdown table's column border fits the column to its content, kept as the file's table 1",
            fitted["sized"] == true
                && saved["1"].as_array().map(|kept| kept.len()) == Some(3)
                && fitted_widths.first().is_some_and(|width| (width - fitted["width"].as_f64().unwrap_or_default()).abs() <= 1.)
                && saved["1"][0].as_f64().is_some_and(|width| width >= MIN_FIT),
            json!({ "before": second, "after": fitted, "saved": saved }),
        );

        // Closed and opened again: both tables come back at their widths.
        self.close_tab(cx, panel)?;
        self.pause(cx, Duration::from_millis(300)).await;
        let panel = self.open(cx, &path, None)?;
        let reopened = match self.table_island(cx, &panel).await {
            Some(island) => {
                let mut facts = (Value::Null, Value::Null);
                let started = std::time::Instant::now();
                while started.elapsed() < Duration::from_secs(5) {
                    facts = (
                        self.evaluate(cx, &island, &table_facts(0)).await,
                        self.evaluate(cx, &island, &table_facts(1)).await,
                    );
                    if facts.0["sized"] == true && facts.1["sized"] == true {
                        break;
                    }
                    self.pause(cx, Duration::from_millis(150)).await;
                }
                Some((island, facts))
            }
            None => None,
        };
        let Some((island, (first, second))) = reopened else {
            steps.check(
                "a Markdown file opened again draws its tables at the column widths kept",
                false,
                json!({ "drawn": false }),
            );
            return Ok(());
        };
        let saved = kept(cx);
        let same = |facts: &Value, table: &str| {
            let shown = px_widths(facts);
            let kept: Vec<f64> = saved[table]
                .as_array()
                .map(|kept| kept.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            !kept.is_empty()
                && shown.len() == kept.len()
                && shown.iter().zip(&kept).all(|(shown, kept)| (shown - kept).abs() < 0.5)
        };
        steps.check(
            "a Markdown file closed and opened again draws its tables at the column widths kept",
            same(&first, "0") && same(&second, "1"),
            json!({ "first": first, "second": second, "saved": saved }),
        );

        // A column added on disk drops the first table's widths, not the second's.
        std::fs::write(&path, WIDER)?;
        self.wait_for(cx, Duration::from_secs(10), |_, _| {
            table_widths::page_widths(root, FILE).get("0").is_none()
        })
        .await;
        self.pause(cx, Duration::from_millis(300)).await;
        let first = self.evaluate(cx, &island, &table_facts(0)).await;
        let second = self.evaluate(cx, &island, &table_facts(1)).await;
        let saved = kept(cx);
        steps.check(
            "a Markdown table whose column count changed drops its kept widths and sizes to its content, the other table keeping its own",
            saved.get("0").is_none()
                && saved.get("1").is_some()
                && first["sized"] == false
                && first["cols"].as_array().map(Vec::len) == Some(3)
                && second["sized"] == true,
            json!({ "first": first, "second": second, "saved": saved }),
        );
        self.close_tab(cx, panel)?;
        Ok(())
    }

    /// The file's visual editor once drawn, with its tables.
    async fn table_island(
        &self,
        cx: &mut AsyncApp,
        panel: &Entity<EditorPanel>,
    ) -> Option<Entity<Island>> {
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
        })?;
        if !drawn {
            return None;
        }
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            let count = self
                .evaluate(cx, &island, "document.querySelectorAll('.lx-md-surface table').length")
                .await;
            if count == 2 {
                return Some(island);
            }
            self.pause(cx, Duration::from_millis(150)).await;
        }
        None
    }
}

/// Narrower than the long header, so a fit that measured it is wider.
const MIN_FIT: f64 = 150.;

/// This file's registration as the e2e module `markdown_table_widths` (`registry.rs`).
pub(super) const MODULE: super::registry::Module = super::registry::Module {
    after: super::registry::After::Repair,
    rank: 81,
    needs: &[],
    setup: false,
    covers: &[
        "gpui/crates/lattice-gpui/src/editor_panel/table_widths.rs",
        "src/editor/markdown/engine/table-column-widths.ts",
    ],
    run: |run, cx, steps, fixture| Box::pin(run.markdown_table_widths(cx, steps, &fixture.root)),
};
