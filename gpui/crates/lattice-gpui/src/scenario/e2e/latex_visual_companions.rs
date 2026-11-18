//! The `latex_visual` module's checks of what the Visual page runs beside
//! its drawing (`editor_panel/latex_visual_events.rs`,
//! `structured/latex_services.rs`):
//!
//! - the outline rail stands over the page's right edge, with a mark for
//!   each of the document's sections (a file outside the manuscript has its
//!   own outline, and a rail needs two marks), as over the source;
//! - a local annotation on the file is marked in the page, with its
//!   numbered pin in the gutter, as in the source, and its mark goes once
//!   it is resolved (`editor_panel/latex_visual_events.rs`).

#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use anyhow::Result;
use gpui::{AsyncApp, Entity};
use lattice_webview::Island;
use serde_json::{Value, json};

use super::{Run, Steps};
use crate::annotations::{model, store};

/// The rail and its marks, as one JSON object.
const COMPANIONS: &str = "JSON.stringify({ \
     rail: !!document.querySelector('.source-editor > .latex-outline-rail'), \
     marks: document.querySelectorAll('.latex-outline-rail-marks > *').length })";

impl Run {
    /// The rail over the page.
    pub(super) async fn latex_visual_companions(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<Island>,
    ) -> Result<()> {
        // The outline comes from the shell's read of the manuscript, a
        // moment late.
        let mut facts = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(15) {
            facts = self.evaluate(cx, island, COMPANIONS).await;
            if facts["rail"] == true && facts["marks"].as_u64().is_some_and(|marks| marks > 0) {
                break;
            }
            self.pause(cx, Duration::from_millis(250)).await;
        }
        steps.check(
            "the outline rail stands over the Visual page with its sections' marks, as over the source",
            facts["rail"] == true && facts["marks"].as_u64().is_some_and(|marks| marks > 0),
            json!({ "rail": facts["rail"], "marks": facts["marks"] }),
        );
        Ok(())
    }

    /// A note on `quote` in the file at `path`, a file at the project's
    /// root, added through the project's annotations, marked and pinned in
    /// the page; resolved, its mark goes.
    pub(super) async fn latex_visual_annotation(
        &self,
        cx: &mut AsyncApp,
        steps: &mut Steps,
        island: &Entity<Island>,
        path: &Path,
        quote: &str,
    ) -> Result<()> {
        let root = path.parent().unwrap_or(Path::new("/"));
        let relative = path.file_name().and_then(|name| name.to_str()).unwrap_or_default();
        let text = std::fs::read_to_string(path)?;
        let start = text.find(quote).unwrap_or(0);
        let id = cx.update(|cx| {
            let author = store::author(root, cx);
            let note = model::new_note(relative, &text, start, start + quote.len(), "Check this.", None, &author)?;
            store::store(cx).update(cx, |store, cx| store.add(root, note, cx))
        });
        let Some(id) = id else {
            steps.check("a local annotation is added to the Visual page's file", false, json!({ "added": false }));
            return Ok(());
        };
        let probe = format!(
            "JSON.stringify({{ \
             mark: document.querySelector('.cm-latex-visual .cm-annotation[data-comment-id={id:?}]')?.textContent ?? null, \
             pins: [...document.querySelectorAll('.cm-latex-visual .cm-annotation-pin')].map((pin) => pin.textContent) }})"
        );
        let mut facts = Value::Null;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            facts = self.evaluate(cx, island, &probe).await;
            if facts["mark"].is_string() && facts["pins"].as_array().is_some_and(|pins| !pins.is_empty()) {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        steps.check(
            "a local annotation on the file is marked in the Visual page over its passage, with its numbered pin in the gutter, as in the source",
            facts["mark"].as_str().is_some_and(|mark| mark.contains(quote))
                && facts["pins"].as_array().is_some_and(|pins| !pins.is_empty()),
            json!({ "page": facts }),
        );
        // The window with the rail and the note, when
        // shots are asked for.
        self.latex_visual_shots(cx).await?;
        cx.update(|cx| {
            store::store(cx).update(cx, |store, cx| store.set_resolved(root, &id, true, cx))
        });
        let mut gone = false;
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(10) {
            gone = self.evaluate(cx, island, &probe).await["mark"].is_null();
            if gone {
                break;
            }
            self.pause(cx, Duration::from_millis(200)).await;
        }
        steps.check(
            "once resolved, the annotation's mark leaves the Visual page",
            gone,
            json!({ "gone": gone }),
        );
        Ok(())
    }
}
